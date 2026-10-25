#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <math.h>
#include <string.h>
#include "../../macos_pcm_queue.h"
#include "macos_audio_trace.h"

enum {
    AKAudioEventPacket = 1,
    AKAudioEventCodecSync = 2,
    AKAudioEventSessionStart = 3,
    AKAudioEventSessionStop = 4,
    AKAudioEventReceived = 5,
    AKAudioEventRejected = 6,
    AKAudioEventReadError = 7,
    AKAudioEventRendered = 8,
    AKAudioEventDiagnostics = 9,
    AKAudioEventLog = 10,
    AKAudioEventControl = 11,
    AKAudioEventOutputReset = 12,
    AKAudioEventRSSI = 13,
    AKAudioEventConnectionReset = 14,
};

enum {
    AKAudioStateStopped = 0,
    AKAudioStateDriverMissing = 1,
    AKAudioStateBluetoothUnavailable = 2,
    AKAudioStateScanning = 3,
    AKAudioStateConnecting = 4,
    AKAudioStateReady = 5,
    AKAudioStateForwarding = 6,
    AKAudioStateError = 7,
};

typedef void (*AKAudioEventCallback)(
    void *context,
    int event,
    const uint8_t *data,
    size_t length,
    int value1,
    int value2
);

typedef struct {
    void *context;
    AKAudioEventCallback on_event;
} AKAudioCallbacks;

// Fixed-width FFI layout, mirrored by NativeMonitorSnapshot in Rust.
// No payloads, audio capture, or render-thread locks are involved.
typedef struct {
    uint64_t uptimeMs, packets, session, streaming, queued, peak, capacity;
    uint64_t underruns, emptied, full, resets, discarded, draining, running;
} AKMonitorSnapshot;

static NSString *const AKDriverUID = @"MiRemoteV2ch_UID";
static NSString *const AKServiceUUIDString = @"AB5E0001-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKTransmitUUIDString = @"AB5E0002-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKAudioUUIDString = @"AB5E0003-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKControlUUIDString = @"AB5E0004-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKBatteryServiceUUIDString = @"180F";
static NSString *const AKBatteryLevelUUIDString = @"2A19";
static const NSTimeInterval AKBatteryRefreshInterval = 30.0;
static const NSTimeInterval AKBatteryRetryInterval = 5.0;
static const NSTimeInterval AKBatteryReadTimeout = 10.0;

static int AKParseBatteryLevel(NSData *data) {
    if (data.length < 1) {
        return -1;
    }
    const uint8_t *bytes = data.bytes;
    return bytes[0] <= 100 ? bytes[0] : -1;
}

static void AKOnMainSync(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

static NSString *AKAudioObjectStringProperty(
    AudioObjectID objectID,
    AudioObjectPropertySelector selector
) {
    AudioObjectPropertyAddress address = {
        selector,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    CFStringRef value = NULL;
    UInt32 size = sizeof(value);
    OSStatus status = AudioObjectGetPropertyData(objectID, &address, 0, NULL, &size, &value);
    if (status != noErr || value == NULL) {
        return nil;
    }
    return CFBridgingRelease(value);
}

static AudioDeviceID AKFindDriverDevice(void) {
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject, &address, 0, NULL, &size
        ) != noErr || size < sizeof(AudioDeviceID)) {
        return kAudioObjectUnknown;
    }
    AudioDeviceID *devices = calloc(1, size);
    if (devices == NULL) {
        return kAudioObjectUnknown;
    }
    AudioDeviceID found = kAudioObjectUnknown;
    if (AudioObjectGetPropertyData(
            kAudioObjectSystemObject, &address, 0, NULL, &size, devices
        ) == noErr) {
        size_t count = size / sizeof(AudioDeviceID);
        for (size_t index = 0; index < count; index++) {
            NSString *uid = AKAudioObjectStringProperty(
                devices[index], kAudioDevicePropertyDeviceUID
            );
            if ([uid isEqualToString:AKDriverUID]) {
                found = devices[index];
                break;
            }
        }
    }
    free(devices);
    return found;
}

static BOOL AKRemoteNameMatches(NSString *name) {
    if (name.length == 0) {
        return NO;
    }
    NSString *normalized = [[name stringByTrimmingCharactersInSet:
        NSCharacterSet.whitespaceAndNewlineCharacterSet] lowercaseString];
    static NSSet<NSString *> *approvedNames;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        approvedNames = [NSSet setWithArray:@[
            @"mi rc",
            @"xiaomi bluetooth remote 2",
            @"xiaomi bluetooth remote 2 pro",
            @"小米蓝牙语音遥控器",
            @"小米蓝牙遥控器2",
            @"小米蓝牙遥控器2 pro",
            @"arn9",
        ]];
    });
    return [approvedNames containsObject:normalized];
}

// Main-thread window counters only. Callback entry is observable; radio arrival
// and time spent waiting for the CoreBluetooth delegate queue are not.
typedef struct {
    NSUInteger callbacks, bytes, minBytes, maxBytes;
    NSUInteger stale, readErrors, missingValue;
    NSUInteger notReady, empty, afterStop, accepted, acceptedBytes;
    NSUInteger gap20, gap50, gap100, gap250;
    NSUInteger enqueueInvalid, enqueueUnavailable, enqueueFull;
    NSUInteger discardedSamples;
    double maxGapMs, maxHandlerMs;
} AKAudioWindow;

static void AKRecordCallbackGap(AKAudioWindow *window, double milliseconds) {
    window->maxGapMs = fmax(window->maxGapMs, milliseconds);
    window->gap20 += milliseconds >= 20;
    window->gap50 += milliseconds >= 50;
    window->gap100 += milliseconds >= 100;
    window->gap250 += milliseconds >= 250;
}

@interface AKAudioPCMStorage : NSObject {
@public
    AKPCMQueue queue;
    atomic_bool outputVerified;
}
@end
@implementation AKAudioPCMStorage
- (instancetype)init {
    self = [super init];
    if (self) {
        AKPCMQueueInit(&queue);
        atomic_init(&outputVerified, false);
    }
    return self;
}
@end

static size_t AKRenderAudio(AKAudioPCMStorage *storage, float *output, size_t count) {
    // Starting a graph can change its device. Retain queued speech until the
    // control thread has verified the actual destination after start returns.
    if (!atomic_load_explicit(&storage->outputVerified, memory_order_acquire)) {
        memset(output, 0, count * sizeof(float));
        return 0;
    }
    return AKPCMQueueRender(&storage->queue, output, count);
}

@interface AKMacAudioBridge : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
- (instancetype)initWithCallbacks:(const AKAudioCallbacks *)callbacks;
- (void)start;
- (void)refresh;
- (BOOL)restart;
- (void)stop;
- (BOOL)enqueueSamples:(const int16_t *)samples count:(size_t)count;
- (int)currentState;
- (BOOL)isBluetoothConnected;
- (BOOL)requestRSSI;
- (void)readMonitor:(AKMonitorSnapshot *)snapshot;
- (BOOL)isForwarding;
- (int)currentBatteryLevel;
- (NSString *)currentError;
- (void)setGainDecibels:(float)decibels;
- (BOOL)setStretchCompensation:(BOOL)enabled;
@end

@implementation AKMacAudioBridge {
    AKAudioCallbacks _callbacks;
    CBCentralManager *_central;
    NSTimeInterval _lastRSSIRequest;
    BOOL _rssiPending;
    uint64_t _monitorPackets, _monitorUnderruns, _monitorEmptied;
    uint64_t _monitorFull, _monitorResets, _monitorDiscarded;
    size_t _monitorPeak;
    CBPeripheral *_peripheral;
    CBCharacteristic *_transmitCharacteristic;
    CBCharacteristic *_audioCharacteristic;
    CBCharacteristic *_controlCharacteristic;
    CBCharacteristic *_batteryLevelCharacteristic;
    NSTimeInterval _nextBatteryReadAt;
    BOOL _batteryReadPending;
    NSUInteger _batteryReadFailures;
    CBUUID *_serviceUUID;
    CBUUID *_transmitUUID;
    CBUUID *_audioUUID;
    CBUUID *_controlUUID;
    CBUUID *_batteryServiceUUID;
    CBUUID *_batteryLevelUUID;
    NSMutableSet<CBUUID *> *_subscribedUUIDs;
    BOOL _shouldRun;
    BOOL _capabilitiesRequested;
    BOOL _capabilitiesConfirmed;
    BOOL _microphoneOpened;
    BOOL _streaming;
    uint16_t _protocolVersion;
    uint8_t _selectedCodec;
    uint8_t _sessionID;
    NSUInteger _frameSize;
    NSUInteger _connectionGeneration;
    NSUInteger _pendingAudioBuffers;
    NSTimeInterval _voiceStartTime;
    BOOL _receivedFirstPacket;
    BOOL _playedFirstBuffer;
    NSTimeInterval _lastPacketTime;
    NSTimeInterval _lastAudioCallbackTime;
    AKAudioWindow _audioWindow;
    double _maxPacketGapMilliseconds;
    NSUInteger _clippedSamples;
    NSUInteger _drainGeneration;
    BOOL _drainRequested;
    CFAbsoluteTime _lastVoiceStopTime;
    int _batteryLevel;
    float _gain;
    BOOL _stretchCompensation;
    int _state;
    NSString *_errorMessage;
    AVAudioEngine *_engine;
    AudioDeviceID _outputDeviceID;
    AVAudioSourceNode *_sourceNode;
    AKAudioPCMStorage *_pcmStorage;
    NSMutableArray<NSNumber *> *_pendingSampleCounts;
    uint64_t _reportedSamples;
    NSTimer *_playbackTimer;
    AVAudioFormat *_sourceFormat;
    NSTimer *_diagnosticsTimer;
    NSTimeInterval _lastDiagnosticsTime;
    AKAudioPacketTrace *_packetTrace;
}

- (instancetype)initWithCallbacks:(const AKAudioCallbacks *)callbacks {
    self = [super init];
    if (self) {
        if (callbacks != NULL) {
            _callbacks = *callbacks;
        }
        _serviceUUID = [CBUUID UUIDWithString:AKServiceUUIDString];
        _transmitUUID = [CBUUID UUIDWithString:AKTransmitUUIDString];
        _audioUUID = [CBUUID UUIDWithString:AKAudioUUIDString];
        _controlUUID = [CBUUID UUIDWithString:AKControlUUIDString];
        _batteryServiceUUID = [CBUUID UUIDWithString:AKBatteryServiceUUIDString];
        _batteryLevelUUID = [CBUUID UUIDWithString:AKBatteryLevelUUIDString];
        _subscribedUUIDs = [NSMutableSet set];
        _pendingSampleCounts = [NSMutableArray array];
        _protocolVersion = 0x0100;
        _selectedCodec = 0x02;
        _frameSize = 120;
        _batteryLevel = -1;
        _gain = 1.0f;
        _state = AKAudioStateStopped;
        NSString *tracePath = NSProcessInfo.processInfo.environment[@"AXONKEY_AUDIO_TRACE_PATH"];
        if (tracePath.length > 0) {
            _packetTrace = [[AKAudioPacketTrace alloc] initWithPath:tracePath];
        }
        _sourceFormat = [[AVAudioFormat alloc]
            initWithCommonFormat:AVAudioPCMFormatFloat32
            sampleRate:16000
            channels:1
            interleaved:NO];
    }
    return self;
}

- (void)setState:(int)state error:(NSString *)error {
    BOOL changed = NO;
    @synchronized (self) {
        changed = _state != state || !(_errorMessage == error || [_errorMessage isEqual:error]);
        _state = state;
        _errorMessage = [error copy];
    }
    if (changed) {
        [self logAudio:[NSString stringWithFormat:@"macOS audio state: state=%d error=%@",
                                                  state, error ?: @"none"]
                 error:error != nil];
    }
}

- (int)currentState {
    @synchronized (self) {
        return _state;
    }
}

- (NSString *)currentError {
    @synchronized (self) {
        return _errorMessage;
    }
}

- (void)setGainDecibels:(float)decibels {
    if (!isfinite(decibels)) {
        decibels = 0.0f;
    }
    @synchronized (self) {
        decibels = fminf(fmaxf(decibels, -30.0f), 30.0f);
        _gain = powf(10.0f, decibels / 20.0f);
    }
}

- (BOOL)isBluetoothConnected {
    @synchronized (self) {
        return _peripheral != nil && _peripheral.state == CBPeripheralStateConnected;
    }
}

// Requested only by the monitor page; closing it stops polling. Reuse the
// existing connection, and bound requests even if the UI polls too quickly.
- (BOOL)requestRSSI {
    if (![self isBluetoothConnected]) return NO;
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if ((!_rssiPending || now - _lastRSSIRequest >= 2.0) && now - _lastRSSIRequest >= 0.2) {
        _rssiPending = YES;
        _lastRSSIRequest = now;
        [_peripheral readRSSI];
    }
    return YES;
}

- (void)peripheral:(CBPeripheral *)peripheral didReadRSSI:(NSNumber *)RSSI error:(NSError *)error {
    if (peripheral != _peripheral || peripheral.state != CBPeripheralStateConnected) return;
    _rssiPending = NO;
    [self emitEvent:AKAudioEventRSSI data:nil
            value1:RSSI.intValue value2:(error != nil || RSSI == nil ? 1 : 0)];
}

- (void)readMonitor:(AKMonitorSnapshot *)snapshot {
    AKPCMQueue *q = _pcmStorage != nil ? &_pcmStorage->queue : NULL;
    uint64_t queued = q != NULL ? AKPCMQueueCount(q) : 0;
    *snapshot = (AKMonitorSnapshot){
        .uptimeMs = (uint64_t)(NSProcessInfo.processInfo.systemUptime * 1000),
        .packets = _monitorPackets, .session = _sessionID, .streaming = _streaming,
        .queued = queued, .peak = MAX(_monitorPeak, q != NULL ? q->monitorPeak : 0),
        .capacity = AKPCMCapacity,
        .underruns = _monitorUnderruns + (q != NULL ? atomic_load(&q->monitorUnderruns) : 0),
        .emptied = _monitorEmptied + (q != NULL ? atomic_load(&q->emptyTransitions) : 0),
        .full = _monitorFull, .resets = _monitorResets, .discarded = _monitorDiscarded,
        .draining = q != NULL && atomic_load(&q->draining), .running = _engine.isRunning,
    };
    _monitorPeak = 0;
    if (q != NULL) q->monitorPeak = queued;
}

- (BOOL)isForwarding {
    @synchronized (self) {
        return _streaming && _engine.isRunning && _sourceNode != nil;
    }
}

- (int)currentBatteryLevel {
    // The public getter may run on a worker thread; CoreBluetooth stays on the
    // same main queue as the existing audio connection and its callbacks.
    AKOnMainSync(^{ [self requestBatteryLevelIfNeeded]; });
    @synchronized (self) {
        return _batteryLevel;
    }
}

- (void)setBatteryLevel:(int)batteryLevel {
    int previous;
    @synchronized (self) {
        previous = _batteryLevel;
        _batteryLevel = batteryLevel;
    }
    if (batteryLevel >= 0 && previous != batteryLevel) {
        [self logAudio:[NSString stringWithFormat:@"RC003 battery level: %d%%", batteryLevel]
                 error:NO];
    }
}

- (void)recordBatteryReadFailure:(NSString *)reason {
    _batteryReadPending = NO;
    _batteryReadFailures += 1;
    BOOL retrySoon = _batteryReadFailures <= 2;
    _nextBatteryReadAt = NSProcessInfo.processInfo.systemUptime +
        (retrySoon ? AKBatteryRetryInterval : AKBatteryRefreshInterval);
    // Keep the last valid value for this connection, and avoid repeating a
    // warning on every UI poll or every retry while the remote is sleeping.
    if (_batteryReadFailures == 1 || _batteryReadFailures == 3) {
        [self logAudio:[NSString stringWithFormat:@"RC003 battery read failed: %@%@",
            reason, retrySoon ? @"; retrying shortly" : @"; retrying every 30 seconds"] error:YES];
    }
}

- (void)requestBatteryLevelIfNeeded {
    if (!_shouldRun || _peripheral == nil ||
        _peripheral.state != CBPeripheralStateConnected ||
        _batteryLevelCharacteristic == nil ||
        (_batteryLevelCharacteristic.properties & CBCharacteristicPropertyRead) == 0) {
        return;
    }
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (now < _nextBatteryReadAt) return;
    if (_batteryReadPending) {
        [self recordBatteryReadFailure:@"request timed out"];
        return;
    }
    _batteryReadPending = YES;
    _nextBatteryReadAt = now + AKBatteryReadTimeout;
    [_peripheral readValueForCharacteristic:_batteryLevelCharacteristic];
}

- (void)emitEvent:(int)event
              data:(NSData *)data
            value1:(int)value1
            value2:(int)value2 {
    if (_callbacks.on_event == NULL) {
        return;
    }
    _callbacks.on_event(
        _callbacks.context,
        event,
        data.bytes,
        data.length,
        value1,
        value2
    );
}

- (void)start {
    _shouldRun = YES;
    [self startDiagnostics];
    [self refresh];
}

- (void)logAudio:(NSString *)message error:(BOOL)error {
    [self emitEvent:AKAudioEventLog
               data:[message dataUsingEncoding:NSUTF8StringEncoding]
             value1:error
             value2:0];
}

- (void)startDiagnostics {
    if (_diagnosticsTimer != nil) {
        return;
    }
    _lastDiagnosticsTime = NSProcessInfo.processInfo.systemUptime;
    __weak AKMacAudioBridge *weakSelf = self;
    _diagnosticsTimer = [NSTimer timerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        [weakSelf reportDiagnostics];
    }];
    [[NSRunLoop mainRunLoop] addTimer:_diagnosticsTimer forMode:NSRunLoopCommonModes];
}

- (void)reportDiagnostics {
    NSTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    int windowMilliseconds = (int)fmin(fmax((now - _lastDiagnosticsTime) * 1000.0, 0), INT32_MAX);
    _lastDiagnosticsTime = now;
    float gain;
    @synchronized (self) {
        gain = _gain;
    }
    NSString *context = [NSString stringWithFormat:
        @"streaming=%d microphone_opened=%d session_id=%u pending_buffers=%lu engine_running=%d output_prepared=%d drain_requested=%d gain_db=%.1f clipped_samples=%lu max_packet_gap_ms=%.1f underruns=%llu queued_samples=%lu",
        _streaming, _microphoneOpened, _sessionID, (unsigned long)_pendingAudioBuffers,
        _engine.isRunning, _sourceNode != nil, _drainRequested, 20.0f * log10f(gain),
        (unsigned long)_clippedSamples, _maxPacketGapMilliseconds,
        (unsigned long long)(_pcmStorage != nil ? atomic_exchange(&_pcmStorage->queue.underruns, 0) : 0),
        (unsigned long)(_pcmStorage != nil ? AKPCMQueueCount(&_pcmStorage->queue) : 0)];
    AKAudioWindow w = _audioWindow;
    context = [context stringByAppendingFormat:
        @" audio_callbacks=%lu callback_bytes=%lu notification_min_bytes=%lu notification_max_bytes=%lu callback_stale=%lu callback_read_errors=%lu callback_missing_value=%lu rejected_not_ready=%lu rejected_empty=%lu rejected_after_stop=%lu accepted_packets=%lu accepted_bytes=%lu callback_gap_ge20=%lu callback_gap_ge50=%lu callback_gap_ge100=%lu callback_gap_ge250=%lu max_callback_gap_ms=%.1f max_callback_handler_ms=%.3f callback_wait_ms=unknown transport_arrival=unknown enqueue_invalid=%lu enqueue_output_unavailable=%lu enqueue_queue_full=%lu discarded_queued_samples=%lu output_verified=%d connection_generation=%lu",
        (unsigned long)w.callbacks, (unsigned long)w.bytes,
        (unsigned long)w.minBytes, (unsigned long)w.maxBytes,
        (unsigned long)w.stale, (unsigned long)w.readErrors, (unsigned long)w.missingValue,
        (unsigned long)w.notReady, (unsigned long)w.empty, (unsigned long)w.afterStop,
        (unsigned long)w.accepted, (unsigned long)w.acceptedBytes,
        (unsigned long)w.gap20, (unsigned long)w.gap50,
        (unsigned long)w.gap100, (unsigned long)w.gap250, w.maxGapMs, w.maxHandlerMs,
        (unsigned long)w.enqueueInvalid, (unsigned long)w.enqueueUnavailable,
        (unsigned long)w.enqueueFull, (unsigned long)w.discardedSamples,
        _pcmStorage != nil && atomic_load(&_pcmStorage->outputVerified),
        (unsigned long)_connectionGeneration];
    BOOL nativeActivity = w.callbacks || w.notReady || w.empty || w.afterStop ||
        w.accepted || w.enqueueInvalid || w.enqueueUnavailable || w.enqueueFull || w.discardedSamples;
    _audioWindow = (AKAudioWindow){0};
    _clippedSamples = 0;
    _maxPacketGapMilliseconds = 0;
    context = [context stringByAppendingFormat:@" stretch_enabled=%d stretch_rate=%.3f stretch_output_samples=%llu",
        _stretchCompensation,
        _pcmStorage != nil ? atomic_load(&_pcmStorage->queue.stretchRatePermille) / 1000.0 : 1.0,
        (unsigned long long)(_pcmStorage != nil ? atomic_exchange(&_pcmStorage->queue.stretchOutputSamples, 0) : 0)];
    [self emitEvent:AKAudioEventDiagnostics
               data:[context dataUsingEncoding:NSUTF8StringEncoding]
             // Bit 0 is forwarding state; bit 1 preserves native-only activity
             // (including stale callbacks) without claiming the session is active.
             value1:((_streaming || _microphoneOpened || _pendingAudioBuffers > 0) ? 1 : 0) |
                    (nativeActivity ? 2 : 0)
             value2:windowMilliseconds];
}

- (void)refresh {
    if (!_shouldRun) {
        return;
    }
    if (AKFindDriverDevice() == kAudioObjectUnknown) {
        [self stopBluetooth];
        [self stopAudioOutput];
        [self setState:AKAudioStateDriverMissing error:nil];
        return;
    }
    if (_central == nil) {
        [self beginBluetooth];
    } else if (_central.state == CBManagerStatePoweredOn && _peripheral == nil) {
        [self discoverOrScan];
    }
}

- (void)stop {
    [self finishPacketTrace];
    [_diagnosticsTimer invalidate];
    _diagnosticsTimer = nil;
    _shouldRun = NO;
    [self closeMicrophoneIfNeeded];
    [self emitEvent:AKAudioEventSessionStop data:nil value1:0 value2:0];
    [self stopBluetooth];
    [self stopAudioOutput];
    [self setState:AKAudioStateStopped error:nil];
    [self reportDiagnostics];
}

- (BOOL)restart {
    [self logAudio:@"Manually restarting macOS audio connections" error:NO];
    // Run teardown and rebuild together on the main queue, so Bluetooth events
    // cannot enqueue into the old graph between these operations.
    [self stop];
    _shouldRun = YES;
    [self startDiagnostics];
    if (![self ensureAudioOutput]) return NO;
    [self setState:AKAudioStateScanning error:nil];
    [self refresh];
    [self scheduleAudioIdle];
    return YES;
}

- (void)beginBluetooth {
    _connectionGeneration += 1;
    _central = [[CBCentralManager alloc]
        initWithDelegate:self
        queue:dispatch_get_main_queue()
        options:@{CBCentralManagerOptionShowPowerAlertKey: @NO}];
}

- (void)stopBluetooth {
    [_central stopScan];
    if (_peripheral != nil) {
        _peripheral.delegate = nil;
        if (_peripheral.state != CBPeripheralStateDisconnected) {
            [_central cancelPeripheralConnection:_peripheral];
        }
    }
    _central.delegate = nil;
    _central = nil;
    [self resetPeripheral];
}

- (void)resetPeripheral {
    _lastRSSIRequest = 0;
    _rssiPending = NO;
    [self emitEvent:AKAudioEventConnectionReset data:nil value1:0 value2:0];
    _peripheral.delegate = nil;
    _peripheral = nil;
    _transmitCharacteristic = nil;
    _audioCharacteristic = nil;
    _controlCharacteristic = nil;
    _batteryLevelCharacteristic = nil;
    _nextBatteryReadAt = 0;
    _batteryReadPending = NO;
    _batteryReadFailures = 0;
    [self setBatteryLevel:-1];
    [_subscribedUUIDs removeAllObjects];
    _capabilitiesRequested = NO;
    _capabilitiesConfirmed = NO;
    _microphoneOpened = NO;
    if (_streaming) {
        _streaming = NO;
        [self emitEvent:AKAudioEventSessionStop data:nil value1:0 value2:0];
    }
    _protocolVersion = 0x0100;
    _selectedCodec = 0x02;
    _sessionID = 0;
    _frameSize = 120;
}

- (void)discoverOrScan {
    if (!_shouldRun || _central.state != CBManagerStatePoweredOn || _peripheral != nil) {
        return;
    }
    NSArray<CBPeripheral *> *connected =
        [_central retrieveConnectedPeripheralsWithServices:@[_serviceUUID]];
    CBPeripheral *candidate = [connected firstObject];
    if (candidate != nil) {
        [self connectPeripheral:candidate];
        return;
    }
    [self setState:AKAudioStateScanning error:nil];
    [_central scanForPeripheralsWithServices:nil
                                    options:@{CBCentralManagerScanOptionAllowDuplicatesKey: @NO}];
}

- (void)connectPeripheral:(CBPeripheral *)peripheral {
    if (!_shouldRun || _peripheral != nil) {
        return;
    }
    [_central stopScan];
    _peripheral = peripheral;
    _peripheral.delegate = self;
    _connectionGeneration += 1;
    NSUInteger generation = _connectionGeneration;
    [self setState:AKAudioStateConnecting error:nil];
    [_central connectPeripheral:peripheral options:nil];
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            if (self->_shouldRun && self->_connectionGeneration == generation &&
                self->_peripheral != nil &&
                self->_peripheral.state != CBPeripheralStateConnected) {
                [self->_central cancelPeripheralConnection:self->_peripheral];
                [self setState:AKAudioStateError error:@"RC003 voice connection timed out"];
            }
        }
    );
}

- (void)scheduleReconnect {
    if (!_shouldRun || AKFindDriverDevice() == kAudioObjectUnknown) {
        return;
    }
    _connectionGeneration += 1;
    NSUInteger generation = _connectionGeneration;
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            if (!self->_shouldRun || self->_connectionGeneration != generation) {
                return;
            }
            if (self->_central == nil) {
                [self beginBluetooth];
            } else {
                [self discoverOrScan];
            }
        }
    );
}

- (BOOL)writeData:(NSData *)data {
    if (_peripheral == nil || _transmitCharacteristic == nil) {
        return NO;
    }
    CBCharacteristicWriteType type =
        (_transmitCharacteristic.properties & CBCharacteristicPropertyWriteWithoutResponse)
            ? CBCharacteristicWriteWithoutResponse
            : CBCharacteristicWriteWithResponse;
    [_peripheral writeValue:data forCharacteristic:_transmitCharacteristic type:type];
    if (data.length > 0) {
        [self logAudio:[NSString stringWithFormat:@"macOS RC003 voice command submitted: opcode=0x%02x write_type=%ld",
                                                  ((const uint8_t *)data.bytes)[0], (long)type]
                 error:NO];
    }
    return YES;
}

- (void)requestCapabilitiesIfReady {
    if (_capabilitiesRequested || _transmitCharacteristic == nil ||
        _audioCharacteristic == nil || _controlCharacteristic == nil ||
        ![_subscribedUUIDs containsObject:_audioUUID] ||
        ![_subscribedUUIDs containsObject:_controlUUID]) {
        return;
    }
    const uint8_t bytes[] = {0x0a, 0x01, 0x00, 0x00, 0x03, 0x03};
    if ([self writeData:[NSData dataWithBytes:bytes length:sizeof(bytes)]]) {
        _capabilitiesRequested = YES;
    }
}

- (BOOL)openMicrophone {
    if (!_capabilitiesConfirmed || _microphoneOpened || _streaming) {
        return NO;
    }
    uint8_t bytes[3] = {0x0c, 0x00, _selectedCodec};
    NSUInteger length = _protocolVersion >= 0x0100 ? 2 : 3;
    if (![self ensureAudioOutput] ||
        ![self writeData:[NSData dataWithBytes:bytes length:length]]) {
        return NO;
    }
    _microphoneOpened = YES;
    return YES;
}

- (void)closeMicrophoneIfNeeded {
    if (!_microphoneOpened && !_streaming) {
        return;
    }
    uint8_t bytes[2] = {0x0d, _sessionID};
    NSUInteger length = _protocolVersion >= 0x0100 ? 2 : 1;
    [self writeData:[NSData dataWithBytes:bytes length:length]];
    _microphoneOpened = NO;
}

- (void)beginVoiceSession {
    if (!_streaming) {
        _voiceStartTime = NSProcessInfo.processInfo.systemUptime;
        _receivedFirstPacket = NO;
        _playedFirstBuffer = NO;
        _lastPacketTime = 0;
        _drainRequested = NO;
        _drainGeneration += 1;
        _lastVoiceStopTime = 0;
        if (_pcmStorage != nil) atomic_store(&_pcmStorage->queue.draining, false);
        _streaming = YES;
        [self emitEvent:AKAudioEventSessionStart data:nil value1:_sessionID value2:0];
    }
    if ([self ensureAudioOutput]) {
        [self setState:AKAudioStateForwarding error:nil];
    }
}

- (void)endVoiceSession {
    if (!_streaming && !_microphoneOpened) {
        return;
    }
    _streaming = NO;
    _microphoneOpened = NO;
    [self emitEvent:AKAudioEventSessionStop data:nil value1:_sessionID value2:0];
    if (_capabilitiesConfirmed) {
        [self setState:AKAudioStateReady error:nil];
    }
    if (_pcmStorage != nil) atomic_store(&_pcmStorage->queue.draining, true);
    _lastVoiceStopTime = CFAbsoluteTimeGetCurrent();
    _drainRequested = YES;
    _drainGeneration += 1;
    NSUInteger generation = _drainGeneration;
    if (_pendingAudioBuffers == 0) {
        _drainRequested = NO;
        [self scheduleAudioIdle];
        return;
    }
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            if (self->_drainRequested && self->_drainGeneration == generation &&
                !self->_streaming) {
                // Clear a stalled tail, but retain the configured output device.
                [self resetAudioQueue];
                [self scheduleAudioIdle];
            }
        }
    );
}

- (void)handleCapabilities:(NSData *)data {
    if (data.length < 7) {
        [self setState:AKAudioStateError error:@"RC003 returned invalid voice capabilities"];
        return;
    }
    const uint8_t *bytes = data.bytes;
    _protocolVersion = ((uint16_t)bytes[1] << 8) | bytes[2];
    uint8_t codecs = bytes[3];
    if (_protocolVersion >= 0x0100 && codecs == 0 && (bytes[4] & 0x03) != 0) {
        codecs = bytes[4];
    }
    _selectedCodec = (codecs & 0x02) != 0 ? 0x02 : 0x01;
    _frameSize = ((NSUInteger)bytes[5] << 8) | bytes[6];
    if (_frameSize == 0) {
        _frameSize = 120;
    }
    [self logAudio:[NSString stringWithFormat:@"macOS RC003 voice format: protocol_version=0x%04x selected_codec=0x%02x frame_bytes=%lu",
                                              _protocolVersion, _selectedCodec, (unsigned long)_frameSize]
             error:NO];
    if (_selectedCodec != 0x02) {
        [self setState:AKAudioStateError error:@"RC003 did not offer 16 kHz voice audio"];
        [self closeMicrophoneIfNeeded];
        return;
    }
    _capabilitiesConfirmed = YES;
    // Warm the output before the remote's first voice press. Starting Core Audio
    // inside a Bluetooth notification delays every notification behind it.
    if ([self ensureAudioOutput]) {
        [self setState:AKAudioStateReady error:nil];
        [self scheduleAudioIdle];
    }
}

- (void)handleControlData:(NSData *)data {
    if (data.length == 0) {
        return;
    }
    const uint8_t *bytes = data.bytes;
    [self emitEvent:AKAudioEventControl data:nil value1:bytes[0] value2:0];
    switch (bytes[0]) {
        case 0x0b:
            [self handleCapabilities:data];
            break;
        case 0x08:
            [self openMicrophone];
            break;
        case 0x04:
            if (!_capabilitiesConfirmed) {
                return;
            }
            if (data.length >= 3 && bytes[2] != 0x02) {
                [self setState:AKAudioStateError error:@"RC003 started an unsupported 8 kHz stream"];
                [self closeMicrophoneIfNeeded];
                return;
            }
            _sessionID = data.length >= 4 ? bytes[3] : 0;
            [self beginVoiceSession];
            break;
        case 0x00:
            [self endVoiceSession];
            break;
        case 0x0a:
            if (data.length >= 7) {
                int16_t predictor = (int16_t)(((uint16_t)bytes[4] << 8) | bytes[5]);
                [self emitEvent:AKAudioEventCodecSync
                           data:nil
                         value1:predictor
                         value2:bytes[6]];
            }
            break;
        default:
            break;
    }
}

- (void)handleAudioData:(NSData *)data {
    [self emitEvent:AKAudioEventReceived data:nil value1:(int)data.length value2:0];
    if (!_capabilitiesConfirmed || data.length == 0) {
        if (!_capabilitiesConfirmed) _audioWindow.notReady += 1;
        else _audioWindow.empty += 1;
        [self emitEvent:AKAudioEventRejected data:nil value1:0 value2:0];
        return;
    }
    if (!_streaming) {
        if (_lastVoiceStopTime > 0 &&
            CFAbsoluteTimeGetCurrent() - _lastVoiceStopTime < 0.3) {
            _audioWindow.afterStop += 1;
            [self emitEvent:AKAudioEventRejected data:nil value1:0 value2:0];
            return;
        }
        [self beginVoiceSession];
    }
    _audioWindow.accepted += 1;
    _audioWindow.acceptedBytes += data.length;
    NSTimeInterval packetTime = NSProcessInfo.processInfo.systemUptime;
    if (_lastPacketTime > 0) {
        _maxPacketGapMilliseconds = fmax(_maxPacketGapMilliseconds,
                                         (packetTime - _lastPacketTime) * 1000.0);
    }
    _lastPacketTime = packetTime;
    if (!_receivedFirstPacket) {
        _receivedFirstPacket = YES;
        [self logAudio:[NSString stringWithFormat:
            @"macOS voice first packet: session_id=%u elapsed_ms=%.1f",
            _sessionID, (NSProcessInfo.processInfo.systemUptime - _voiceStartTime) * 1000.0]
                 error:NO];
    }
    [self emitEvent:AKAudioEventPacket
               data:data
             value1:(int)_frameSize
             value2:0];
}

- (AudioDeviceID)driverDeviceID {
    // Resolve the stable UID again: numeric IDs can change after driver reload.
    return AKFindDriverDevice();
}

- (OSStatus)selectOutputDevice:(AudioDeviceID)deviceID {
    AudioUnit unit = _engine.outputNode.audioUnit;
    if (unit == NULL) return kAudio_ParamError;
    return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                               kAudioUnitScope_Global, 0, &deviceID, sizeof(deviceID));
}

- (BOOL)outputTargetsDriver {
    if (_outputDeviceID == kAudioObjectUnknown) return NO;
    AudioUnit unit = _engine.outputNode.audioUnit;
    if (unit == NULL) return NO;
    AudioDeviceID selected = kAudioObjectUnknown;
    UInt32 size = sizeof(selected);
    return AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                               kAudioUnitScope_Global, 0, &selected, &size) == noErr &&
           selected == _outputDeviceID &&
           [AKAudioObjectStringProperty(selected, kAudioDevicePropertyDeviceUID)
               isEqualToString:AKDriverUID];
}

- (BOOL)ensureAudioOutput {
    // Core Audio can redirect an existing graph when output devices change.
    // Never enqueue remote speech into a graph now targeting real speakers.
    if (_engine.isRunning && _sourceNode != nil && ![self outputTargetsDriver]) {
        [self logAudio:@"macOS audio output device changed; rebuilding MiRemoteV connection" error:YES];
        [self stopAudioOutput];
    }
    if (_engine.isRunning && _sourceNode != nil) return YES;
    // Restart the configured graph after idle pause or a device format change.
    if (_engine != nil && _sourceNode != nil) {
        atomic_store_explicit(&_pcmStorage->outputVerified, false, memory_order_release);
        AudioDeviceID deviceID = [self driverDeviceID];
        if (deviceID == kAudioObjectUnknown) {
            [self stopAudioOutput];
            [self setState:AKAudioStateDriverMissing error:nil];
            return NO;
        }
        OSStatus selectStatus = [self selectOutputDevice:deviceID];
        _outputDeviceID = deviceID;
        if (selectStatus != noErr || ![self outputTargetsDriver]) {
            [self stopAudioOutput];
            [self setState:AKAudioStateError error:@"未能将音频输出连接到 MiRemoteV 2ch，请重试"];
            return NO;
        }
        NSError *error = nil;
        if (![_engine startAndReturnError:&error]) {
            [self stopAudioOutput];
            [self setState:AKAudioStateError error:error.localizedDescription ?: @"Cannot resume MiRemoteV 2ch"];
            return NO;
        }
        if (![self outputTargetsDriver]) {
            [self logAudio:@"macOS audio output redirected during resume; rebuilding MiRemoteV connection" error:YES];
            [self stopAudioOutput];
            return [self createAudioOutput];
        }
        atomic_store_explicit(&_pcmStorage->outputVerified, true, memory_order_release);
        [self logAudio:@"macOS audio output resumed" error:NO];
        return YES;
    }
    return [self createAudioOutput];
}

- (BOOL)createAudioOutput {
    [self stopAudioOutput];
    AudioDeviceID deviceID = [self driverDeviceID];
    if (deviceID == kAudioObjectUnknown) {
        [self setState:AKAudioStateDriverMissing error:nil];
        return NO;
    }

    AVAudioEngine *engine = [[AVAudioEngine alloc] init];
    AudioUnit outputUnit = engine.outputNode.audioUnit;
    if (outputUnit == NULL) {
        [self setState:AKAudioStateError error:@"Core Audio output unit is unavailable"];
        return NO;
    }
    OSStatus selectStatus = AudioUnitSetProperty(
        outputUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &deviceID,
        sizeof(deviceID)
    );
    if (selectStatus != noErr) {
        [self setState:AKAudioStateError
                 error:[NSString stringWithFormat:@"Cannot select MiRemoteV 2ch (%d)", selectStatus]];
        return NO;
    }
    // Establish the graph only after choosing the device so the mixer doesn't
    // inherit the system default output's channel count and sample rate.
    AKAudioPCMStorage *storage = [[AKAudioPCMStorage alloc] init];
    storage->queue.stretchEnabled = _stretchCompensation;
    AVAudioSourceNode *source = [[AVAudioSourceNode alloc]
        initWithFormat:_sourceFormat
        renderBlock:^OSStatus(BOOL *isSilence, const AudioTimeStamp *timestamp,
                              AVAudioFrameCount frameCount, AudioBufferList *output) {
            (void)timestamp;
            float *channel = output->mBuffers[0].mData;
            AKRenderAudio(storage, channel, frameCount);
            // Fades can contain nonzero samples even when a packet ends here.
            *isSilence = NO;
            return noErr;
        }];
    [engine attachNode:source];
    [engine connect:source to:engine.mainMixerNode format:_sourceFormat];
    [engine connect:engine.mainMixerNode to:engine.outputNode
             format:[engine.outputNode inputFormatForBus:0]];
    NSError *startError = nil;
    [engine prepare];
    if (![engine startAndReturnError:&startError]) {
        [self setState:AKAudioStateError
                 error:[NSString stringWithFormat:@"Cannot start MiRemoteV 2ch: %@",
                                                   startError.localizedDescription ?: @"unknown error"]];
        return NO;
    }
    AudioDeviceID selectedDevice = kAudioObjectUnknown;
    UInt32 selectedDeviceSize = sizeof(selectedDevice);
    OSStatus readStatus = AudioUnitGetProperty(outputUnit,
        kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
        &selectedDevice, &selectedDeviceSize);
    if (readStatus != noErr || selectedDevice != deviceID ||
        ![AKAudioObjectStringProperty(selectedDevice, kAudioDevicePropertyDeviceUID)
            isEqualToString:AKDriverUID]) {
        [engine stop];
        [self setState:AKAudioStateError error:@"未能将音频输出连接到 MiRemoteV 2ch，请重试"];
        return NO;
    }
    _engine = engine;
    _outputDeviceID = deviceID;
    _sourceNode = source;
    _pcmStorage = storage;
    atomic_store_explicit(&storage->outputVerified, true, memory_order_release);
    AVAudioFormat *outputFormat = [engine.outputNode outputFormatForBus:0];
    [self logAudio:[NSString stringWithFormat:@"macOS audio output ready: device=MiRemoteV2ch_UID source_sample_rate=%.0f source_channels=%u source_format=float32 output_sample_rate=%.0f output_channels=%u",
                                              _sourceFormat.sampleRate, _sourceFormat.channelCount,
                                              outputFormat.sampleRate, outputFormat.channelCount]
             error:NO];
    return YES;
}

- (BOOL)setStretchCompensation:(BOOL)enabled {
    if (_stretchCompensation == enabled) return YES;
    // Do not reset or modify consumer-owned DSP state while it is rendering.
    // The caller can retry after releasing the key and draining the final audio.
    [self collectRenderedAudio];
    if (_streaming || _microphoneOpened || _pendingAudioBuffers > 0) return NO;
    [self resetAudioQueue];
    _stretchCompensation = enabled;
    if (_pcmStorage != nil) _pcmStorage->queue.stretchEnabled = enabled;
    [self logAudio:[NSString stringWithFormat:@"macOS audio stretch compensation: enabled=%d", enabled] error:NO];
    return YES;
}

- (BOOL)enqueueSamples:(const int16_t *)samples count:(size_t)count {
    if (samples == NULL || count == 0) {
        _audioWindow.enqueueInvalid += 1;
        return NO;
    }
    if (![self ensureAudioOutput]) {
        _audioWindow.enqueueUnavailable += 1;
        return NO;
    }
    float gain;
    @synchronized (self) { gain = _gain; }
    size_t clipped = 0;
    if (!AKPCMQueuePush(&_pcmStorage->queue, samples, count, gain, &clipped)) {
        _audioWindow.enqueueFull += 1;
        _monitorFull += 1;
        return NO;
    }
    _clippedSamples += clipped;
    [_pendingSampleCounts addObject:@(count)];
    _pendingAudioBuffers += 1;
    if (_playbackTimer == nil) {
        __weak AKMacAudioBridge *weakSelf = self;
        _playbackTimer = [NSTimer timerWithTimeInterval:0.01 repeats:YES block:^(NSTimer *timer) {
            (void)timer;
            [weakSelf collectRenderedAudio];
        }];
        [[NSRunLoop mainRunLoop] addTimer:_playbackTimer forMode:NSRunLoopCommonModes];
    }
    return YES;
}

- (void)collectRenderedAudio {
    if (_pcmStorage == nil) return;
    uint64_t rendered = atomic_load_explicit(&_pcmStorage->queue.read, memory_order_acquire);
    if (rendered > _reportedSamples && !_playedFirstBuffer) {
        _playedFirstBuffer = YES;
        [self logAudio:[NSString stringWithFormat:
            @"macOS voice first audio rendered: session_id=%u elapsed_ms=%.1f",
            _sessionID, (NSProcessInfo.processInfo.systemUptime - _voiceStartTime) * 1000.0]
                 error:NO];
    }
    while (_pendingSampleCounts.count > 0) {
        NSUInteger count = _pendingSampleCounts.firstObject.unsignedIntegerValue;
        if (rendered - _reportedSamples < count) break;
        _reportedSamples += count;
        [_pendingSampleCounts removeObjectAtIndex:0];
        _pendingAudioBuffers -= 1;
        [self emitEvent:AKAudioEventRendered data:nil value1:(int)count value2:0];
    }
    if (_pendingAudioBuffers == 0 && !_streaming) {
        [_playbackTimer invalidate];
        _playbackTimer = nil;
        if (_drainRequested) {
            _drainRequested = NO;
            [self scheduleAudioIdle];
        }
    }
}

- (void)scheduleAudioIdle {
    // Keep quick consecutive presses warm without holding Core Audio IO open
    // indefinitely (which can prevent idle sleep). Pause retains the graph.
    NSUInteger generation = ++_drainGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC),
                   dispatch_get_main_queue(), ^{
        if (self->_drainGeneration == generation && !self->_streaming &&
            !self->_microphoneOpened && self->_pendingAudioBuffers == 0) {
            if (self->_pcmStorage != nil)
                atomic_store_explicit(&self->_pcmStorage->outputVerified, false, memory_order_release);
            [self->_engine pause];
        }
    });
}

- (void)resetAudioQueue {
    // Stop the render thread before resetting its single-consumer state.
    [_engine stop];
    [_playbackTimer invalidate];
    _playbackTimer = nil;
    if (_pendingAudioBuffers > 0) {
        [self emitEvent:AKAudioEventOutputReset data:nil value1:(int)_pendingAudioBuffers value2:0];
    }
    _drainGeneration += 1;
    _drainRequested = NO;
    _pendingAudioBuffers = 0;
    [_pendingSampleCounts removeAllObjects];
    _reportedSamples = 0;
    if (_pcmStorage != nil) {
        size_t discarded = AKPCMQueueCount(&_pcmStorage->queue);
        _monitorResets += 1;
        _monitorDiscarded += discarded;
        _monitorUnderruns += atomic_load(&_pcmStorage->queue.monitorUnderruns);
        _monitorEmptied += atomic_load(&_pcmStorage->queue.emptyTransitions);
        _monitorPeak = MAX(_monitorPeak, _pcmStorage->queue.monitorPeak);
        _audioWindow.discardedSamples += discarded;
        AKPCMQueueInit(&_pcmStorage->queue);
        _pcmStorage->queue.stretchEnabled = _stretchCompensation;
    }
}

- (void)stopAudioOutput {
    if (_pcmStorage != nil)
        atomic_store_explicit(&_pcmStorage->outputVerified, false, memory_order_release);
    [self resetAudioQueue];
    _sourceNode = nil;
    _pcmStorage = nil;
    _engine = nil;
    _outputDeviceID = kAudioObjectUnknown;
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    if (central != _central || !_shouldRun) {
        return;
    }
    switch (central.state) {
        case CBManagerStatePoweredOn:
            [self discoverOrScan];
            break;
        case CBManagerStateUnauthorized:
            [self setState:AKAudioStateBluetoothUnavailable
                     error:@"Bluetooth permission is required for RC003 voice audio"];
            break;
        case CBManagerStatePoweredOff:
            [self setState:AKAudioStateBluetoothUnavailable error:@"Bluetooth is turned off"];
            break;
        case CBManagerStateUnsupported:
            [self setState:AKAudioStateBluetoothUnavailable
                     error:@"Bluetooth Low Energy is unavailable"];
            break;
        case CBManagerStateResetting:
        case CBManagerStateUnknown:
            [self setState:AKAudioStateBluetoothUnavailable
                     error:@"Bluetooth is initializing"];
            break;
    }
}

- (void)centralManager:(CBCentralManager *)central
 didDiscoverPeripheral:(CBPeripheral *)peripheral
     advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                  RSSI:(NSNumber *)RSSI {
    if (central != _central || _peripheral != nil) {
        return;
    }
    NSString *advertisedName = advertisementData[CBAdvertisementDataLocalNameKey];
    NSArray<CBUUID *> *services = advertisementData[CBAdvertisementDataServiceUUIDsKey];
    if ([services containsObject:_serviceUUID] || AKRemoteNameMatches(peripheral.name) ||
        AKRemoteNameMatches(advertisedName)) {
        [self connectPeripheral:peripheral];
    }
}

- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    if (central != _central || peripheral != _peripheral || !_shouldRun) {
        return;
    }
    peripheral.delegate = self;
    [peripheral discoverServices:@[_serviceUUID, _batteryServiceUUID]];
    NSUInteger generation = _connectionGeneration;
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8 * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            if (self->_shouldRun && self->_connectionGeneration == generation &&
                self->_peripheral == peripheral && !self->_capabilitiesConfirmed) {
                [self setState:AKAudioStateError
                         error:@"RC003 voice service initialization timed out"];
                [self->_central cancelPeripheralConnection:peripheral];
            }
        }
    );
}

- (void)centralManager:(CBCentralManager *)central
 didFailToConnectPeripheral:(CBPeripheral *)peripheral
                  error:(NSError *)error {
    if (central != _central || peripheral != _peripheral) {
        return;
    }
    [self setState:AKAudioStateError
             error:[NSString stringWithFormat:@"Cannot connect RC003 voice service: %@",
                                               error.localizedDescription ?: @"unknown error"]];
    [self resetPeripheral];
    [self scheduleReconnect];
}

- (void)centralManager:(CBCentralManager *)central
 didDisconnectPeripheral:(CBPeripheral *)peripheral
                  error:(NSError *)error {
    if (central != _central || peripheral != _peripheral) {
        return;
    }
    [self stopAudioOutput];
    [self resetPeripheral];
    [self setState:AKAudioStateScanning error:error.localizedDescription];
    [self scheduleReconnect];
}

- (void)centralManager:(CBCentralManager *)central
 didDisconnectPeripheral:(CBPeripheral *)peripheral
               timestamp:(CFAbsoluteTime)timestamp
            isReconnecting:(BOOL)isReconnecting
                  error:(NSError *)error {
    [self centralManager:central didDisconnectPeripheral:peripheral error:error];
}

- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    if (peripheral != _peripheral) {
        return;
    }
    if (error != nil) {
        [self setState:AKAudioStateError error:error.localizedDescription];
        [_central cancelPeripheralConnection:peripheral];
        return;
    }
    CBService *voiceService = nil;
    CBService *batteryService = nil;
    for (CBService *service in peripheral.services) {
        if ([service.UUID isEqual:_serviceUUID]) {
            voiceService = service;
        } else if ([service.UUID isEqual:_batteryServiceUUID]) {
            batteryService = service;
        }
    }
    if (voiceService == nil) {
        [self setState:AKAudioStateError error:@"RC003 voice service was not found"];
        [_central cancelPeripheralConnection:peripheral];
        return;
    }
    [peripheral discoverCharacteristics:@[_transmitUUID, _audioUUID, _controlUUID]
                             forService:voiceService];
    if (batteryService != nil) {
        [peripheral discoverCharacteristics:@[_batteryLevelUUID] forService:batteryService];
    } else {
        [self logAudio:@"RC003 battery service 180F was not found" error:YES];
    }
}

- (void)peripheral:(CBPeripheral *)peripheral
 didDiscoverCharacteristicsForService:(CBService *)service
              error:(NSError *)error {
    if (peripheral != _peripheral) {
        return;
    }
    if ([service.UUID isEqual:_batteryServiceUUID]) {
        if (error != nil) {
            [self logAudio:[NSString stringWithFormat:@"RC003 battery characteristic discovery failed: %@",
                error.localizedDescription] error:YES];
            return;
        }
        for (CBCharacteristic *characteristic in service.characteristics) {
            if (![characteristic.UUID isEqual:_batteryLevelUUID]) {
                continue;
            }
            _batteryLevelCharacteristic = characteristic;
            [self requestBatteryLevelIfNeeded];
            CBCharacteristicProperties properties = characteristic.properties;
            if ((properties & CBCharacteristicPropertyNotify) != 0 ||
                (properties & CBCharacteristicPropertyIndicate) != 0) {
                [peripheral setNotifyValue:YES forCharacteristic:characteristic];
            }
            return;
        }
        [self logAudio:@"RC003 battery characteristic 2A19 was not found" error:YES];
        return;
    }
    if (![service.UUID isEqual:_serviceUUID]) {
        return;
    }
    if (error != nil) {
        [self setState:AKAudioStateError error:error.localizedDescription];
        [_central cancelPeripheralConnection:peripheral];
        return;
    }
    for (CBCharacteristic *characteristic in service.characteristics) {
        if ([characteristic.UUID isEqual:_transmitUUID]) {
            _transmitCharacteristic = characteristic;
        } else if ([characteristic.UUID isEqual:_audioUUID]) {
            _audioCharacteristic = characteristic;
            [peripheral setNotifyValue:YES forCharacteristic:characteristic];
        } else if ([characteristic.UUID isEqual:_controlUUID]) {
            _controlCharacteristic = characteristic;
            [peripheral setNotifyValue:YES forCharacteristic:characteristic];
        }
    }
    if (_transmitCharacteristic == nil || _audioCharacteristic == nil ||
        _controlCharacteristic == nil) {
        [self setState:AKAudioStateError error:@"RC003 voice characteristics are incomplete"];
        [_central cancelPeripheralConnection:peripheral];
        return;
    }
    [self requestCapabilitiesIfReady];
}

- (void)peripheral:(CBPeripheral *)peripheral
 didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic
              error:(NSError *)error {
    if (peripheral == _peripheral &&
        [characteristic.UUID isEqual:_batteryLevelUUID]) {
        if (error != nil || !characteristic.isNotifying) {
            [self logAudio:[NSString stringWithFormat:@"RC003 battery notifications unavailable: %@; using reads",
                error.localizedDescription ?: @"notifications are inactive"] error:YES];
        }
        return;
    }
    if (peripheral != _peripheral || error != nil || !characteristic.isNotifying) {
        if (error != nil) {
            [self setState:AKAudioStateError error:error.localizedDescription];
            [_central cancelPeripheralConnection:peripheral];
        } else if (peripheral == _peripheral &&
                   ([characteristic.UUID isEqual:_audioUUID] ||
                    [characteristic.UUID isEqual:_controlUUID])) {
            [self setState:AKAudioStateError
                     error:@"RC003 voice notification channel is inactive"];
            [_central cancelPeripheralConnection:peripheral];
        }
        return;
    }
    if ([characteristic.UUID isEqual:_audioUUID] ||
        [characteristic.UUID isEqual:_controlUUID]) {
        [_subscribedUUIDs addObject:characteristic.UUID];
        [self requestCapabilitiesIfReady];
    }
}

- (void)peripheral:(CBPeripheral *)peripheral
 didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic
              error:(NSError *)error {
    BOOL audio = [characteristic.UUID isEqual:_audioUUID];
    NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
    if (audio && _packetTrace != nil && !_packetTrace.sealed) {
        BOOL first = !_packetTrace.started;
        uint32_t flags = (peripheral != _peripheral ? 1 : 0) |
                         (error != nil ? 2 : 0) | (characteristic.value == nil ? 4 : 0);
        [_packetTrace recordData:characteristic.value uptime:started
            unixTime:CFAbsoluteTimeGetCurrent() + kCFAbsoluteTimeIntervalSince1970
            session:_sessionID flags:flags];
        if (first) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC),
                dispatch_get_main_queue(), ^{ [self finishPacketTrace]; });
        }
    }
    if (audio) {
        NSUInteger bytes = characteristic.value.length;
        if (_audioWindow.callbacks == 0) _audioWindow.minBytes = bytes;
        _audioWindow.callbacks += 1;
        _audioWindow.bytes += bytes;
        _audioWindow.minBytes = MIN(_audioWindow.minBytes, bytes);
        _audioWindow.maxBytes = MAX(_audioWindow.maxBytes, bytes);
        if (peripheral != _peripheral) _audioWindow.stale += 1;
        else {
            if (error != nil) _audioWindow.readErrors += 1;
            else if (characteristic.value == nil) _audioWindow.missingValue += 1;
            // Do not count button-up silence as a transport gap. Retain the
            // previous callback across diagnostic windows within a session.
            if (_streaming && _receivedFirstPacket && _lastAudioCallbackTime > 0)
                AKRecordCallbackGap(&_audioWindow, (started - _lastAudioCallbackTime) * 1000.0);
            _lastAudioCallbackTime = started;
        }
    }
    [self handleValueForPeripheral:peripheral characteristic:characteristic error:error];
    if (audio) _audioWindow.maxHandlerMs = fmax(_audioWindow.maxHandlerMs,
        (NSProcessInfo.processInfo.systemUptime - started) * 1000.0);
}

- (void)finishPacketTrace {
    AKAudioPacketTrace *trace = _packetTrace;
    if (trace == nil || trace.sealed || !trace.started) return;
    [trace seal];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        BOOL saved = [trace writeCSV];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self logAudio:[NSString stringWithFormat:
                @"macOS packet trace: callbacks=%lu saved=%d (one-shot capture ended)",
                (unsigned long)trace.count, saved] error:!saved];
        });
    });
}

- (void)handleValueForPeripheral:(CBPeripheral *)peripheral
                 characteristic:(CBCharacteristic *)characteristic
                          error:(NSError *)error {
    if (peripheral == _peripheral &&
        [characteristic.UUID isEqual:_batteryLevelUUID]) {
        int level = error == nil ? AKParseBatteryLevel(characteristic.value) : -1;
        if (level < 0) {
            [self recordBatteryReadFailure:error.localizedDescription ?:
                [NSString stringWithFormat:@"invalid percentage (value length=%lu)",
                    (unsigned long)characteristic.value.length]];
        } else {
            _batteryReadPending = NO;
            _batteryReadFailures = 0;
            _nextBatteryReadAt = NSProcessInfo.processInfo.systemUptime + AKBatteryRefreshInterval;
            [self setBatteryLevel:level];
        }
        return;
    }
    if (peripheral != _peripheral) {
        return;
    }
    if (error != nil || characteristic.value == nil) {
        if ([characteristic.UUID isEqual:_audioUUID] || [characteristic.UUID isEqual:_controlUUID]) {
            [self emitEvent:AKAudioEventReadError data:nil value1:0 value2:0];
        }
        return;
    }
    if ([characteristic.UUID isEqual:_controlUUID]) {
        [self handleControlData:characteristic.value];
    } else if ([characteristic.UUID isEqual:_audioUUID]) {
        _monitorPackets += 1;
        [self handleAudioData:characteristic.value];
    }
}

@end

void *axonkey_macos_audio_create(const AKAudioCallbacks *callbacks) {
    __block AKMacAudioBridge *bridge = nil;
    AKOnMainSync(^{
        bridge = [[AKMacAudioBridge alloc] initWithCallbacks:callbacks];
    });
    return (__bridge_retained void *)bridge;
}

void axonkey_macos_audio_start(void *rawBridge) {
    if (rawBridge == NULL) {
        return;
    }
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ [bridge start]; });
}

void axonkey_macos_audio_refresh(void *rawBridge) {
    if (rawBridge == NULL) {
        return;
    }
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ [bridge refresh]; });
}

bool axonkey_macos_audio_restart(void *rawBridge) {
    if (rawBridge == NULL) return false;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    __block BOOL restarted = NO;
    AKOnMainSync(^{ restarted = [bridge restart]; });
    return restarted;
}

void axonkey_macos_audio_stop(void *rawBridge) {
    if (rawBridge == NULL) {
        return;
    }
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ [bridge stop]; });
}

void axonkey_macos_audio_destroy(void *rawBridge) {
    if (rawBridge == NULL) {
        return;
    }
    AKOnMainSync(^{
        AKMacAudioBridge *bridge = (__bridge_transfer AKMacAudioBridge *)rawBridge;
        [bridge stop];
    });
}

bool axonkey_macos_audio_driver_installed(void) {
    return AKFindDriverDevice() != kAudioObjectUnknown;
}

int axonkey_macos_audio_state(void *rawBridge) {
    if (rawBridge == NULL) {
        return AKAudioStateError;
    }
    __block int state = AKAudioStateError;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ state = [bridge currentState]; });
    return state;
}

bool axonkey_macos_audio_bluetooth_connected(void *rawBridge) {
    if (rawBridge == NULL) {
        return false;
    }
    __block BOOL connected = NO;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ connected = [bridge isBluetoothConnected]; });
    return connected;
}

bool axonkey_macos_audio_request_rssi(void *rawBridge) {
    if (rawBridge == NULL) return false;
    __block BOOL connected = NO;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ connected = [bridge requestRSSI]; });
    return connected;
}

bool axonkey_macos_audio_forwarding(void *rawBridge) {
    if (rawBridge == NULL) {
        return false;
    }
    __block BOOL forwarding = NO;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ forwarding = [bridge isForwarding]; });
    return forwarding;
}

int axonkey_macos_audio_battery_level(void *rawBridge) {
    if (rawBridge == NULL) {
        return -1;
    }
    __block int batteryLevel = -1;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ batteryLevel = [bridge currentBatteryLevel]; });
    return batteryLevel;
}

size_t axonkey_macos_audio_copy_error(void *rawBridge, char *buffer, size_t capacity) {
    if (rawBridge == NULL || buffer == NULL || capacity == 0) {
        return 0;
    }
    __block NSString *error = nil;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ error = [bridge currentError]; });
    NSData *data = [error dataUsingEncoding:NSUTF8StringEncoding];
    if (data.length == 0) {
        buffer[0] = '\0';
        return 0;
    }
    size_t length = MIN(data.length, capacity - 1);
    memcpy(buffer, data.bytes, length);
    buffer[length] = '\0';
    return length;
}

bool axonkey_macos_audio_enqueue(void *rawBridge, const int16_t *samples, size_t count) {
    if (rawBridge == NULL) {
        return false;
    }
    __block BOOL accepted = NO;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ accepted = [bridge enqueueSamples:samples count:count]; });
    return accepted;
}

void axonkey_macos_audio_set_gain_db(void *rawBridge, float gain_db) {
    if (rawBridge == NULL) {
        return;
    }
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    AKOnMainSync(^{ [bridge setGainDecibels:gain_db]; });
}

bool axonkey_macos_audio_set_stretch_compensation(void *rawBridge, bool enabled) {
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    if (bridge == nil) return false;
    __block BOOL accepted = NO;
    AKOnMainSync(^{ accepted = [bridge setStretchCompensation:enabled]; });
    return accepted;
}

bool axonkey_macos_audio_monitor(void *rawBridge, AKMonitorSnapshot *snapshot) {
    if (rawBridge == NULL || snapshot == NULL) return false;
    AKMacAudioBridge *bridge = (__bridge AKMacAudioBridge *)rawBridge;
    __block BOOL connected = NO;
    AKOnMainSync(^{
        connected = [bridge requestRSSI];
        [bridge readMonitor:snapshot];
    });
    return connected;
}
