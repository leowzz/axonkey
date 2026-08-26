#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <math.h>
#include <string.h>

enum {
    AKAudioEventPacket = 1,
    AKAudioEventCodecSync = 2,
    AKAudioEventSessionStart = 3,
    AKAudioEventSessionStop = 4,
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

static NSString *const AKDriverUID = @"MiRemoteV2ch_UID";
static NSString *const AKServiceUUIDString = @"AB5E0001-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKTransmitUUIDString = @"AB5E0002-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKAudioUUIDString = @"AB5E0003-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKControlUUIDString = @"AB5E0004-5A21-4F05-BC7D-AF01F617B664";
static NSString *const AKBatteryServiceUUIDString = @"180F";
static NSString *const AKBatteryLevelUUIDString = @"2A19";

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
    return [(__bridge NSString *)value copy];
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

@interface AKMacAudioBridge : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
- (instancetype)initWithCallbacks:(const AKAudioCallbacks *)callbacks;
- (void)start;
- (void)refresh;
- (void)stop;
- (BOOL)enqueueSamples:(const int16_t *)samples count:(size_t)count;
- (int)currentState;
- (BOOL)isBluetoothConnected;
- (BOOL)isForwarding;
- (int)currentBatteryLevel;
- (NSString *)currentError;
- (void)setGainDecibels:(float)decibels;
@end

@implementation AKMacAudioBridge {
    AKAudioCallbacks _callbacks;
    CBCentralManager *_central;
    CBPeripheral *_peripheral;
    CBCharacteristic *_transmitCharacteristic;
    CBCharacteristic *_audioCharacteristic;
    CBCharacteristic *_controlCharacteristic;
    CBCharacteristic *_batteryLevelCharacteristic;
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
    NSUInteger _drainGeneration;
    BOOL _drainRequested;
    CFAbsoluteTime _lastVoiceStopTime;
    int _batteryLevel;
    float _gain;
    int _state;
    NSString *_errorMessage;
    AVAudioEngine *_engine;
    AVAudioPlayerNode *_player;
    AVAudioFormat *_sourceFormat;
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
        _protocolVersion = 0x0100;
        _selectedCodec = 0x02;
        _frameSize = 120;
        _batteryLevel = -1;
        _gain = 1.0f;
        _state = AKAudioStateStopped;
        _sourceFormat = [[AVAudioFormat alloc]
            initWithCommonFormat:AVAudioPCMFormatFloat32
            sampleRate:16000
            channels:1
            interleaved:NO];
    }
    return self;
}

- (void)setState:(int)state error:(NSString *)error {
    @synchronized (self) {
        _state = state;
        _errorMessage = [error copy];
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

- (BOOL)isForwarding {
    @synchronized (self) {
        return _streaming && _engine.isRunning && _player.isPlaying;
    }
}

- (int)currentBatteryLevel {
    @synchronized (self) {
        return _batteryLevel;
    }
}

- (void)setBatteryLevel:(int)batteryLevel {
    @synchronized (self) {
        _batteryLevel = batteryLevel;
    }
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
    [self refresh];
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
    _shouldRun = NO;
    [self closeMicrophoneIfNeeded];
    [self emitEvent:AKAudioEventSessionStop data:nil value1:0 value2:0];
    [self stopBluetooth];
    [self stopAudioOutput];
    [self setState:AKAudioStateStopped error:nil];
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
    _peripheral.delegate = nil;
    _peripheral = nil;
    _transmitCharacteristic = nil;
    _audioCharacteristic = nil;
    _controlCharacteristic = nil;
    _batteryLevelCharacteristic = nil;
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
        _drainRequested = NO;
        _drainGeneration += 1;
        _lastVoiceStopTime = 0;
        _streaming = YES;
        [self emitEvent:AKAudioEventSessionStart data:nil value1:0 value2:0];
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
    [self emitEvent:AKAudioEventSessionStop data:nil value1:0 value2:0];
    if (_capabilitiesConfirmed) {
        [self setState:AKAudioStateReady error:nil];
    }
    _lastVoiceStopTime = CFAbsoluteTimeGetCurrent();
    _drainRequested = YES;
    _drainGeneration += 1;
    NSUInteger generation = _drainGeneration;
    if (_pendingAudioBuffers == 0) {
        [self stopAudioOutput];
        return;
    }
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            if (self->_drainRequested && self->_drainGeneration == generation &&
                !self->_streaming) {
                [self stopAudioOutput];
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
    if (_selectedCodec != 0x02) {
        [self setState:AKAudioStateError error:@"RC003 did not offer 16 kHz voice audio"];
        [self closeMicrophoneIfNeeded];
        return;
    }
    _capabilitiesConfirmed = YES;
    [self setState:AKAudioStateReady error:nil];
}

- (void)handleControlData:(NSData *)data {
    if (data.length == 0) {
        return;
    }
    const uint8_t *bytes = data.bytes;
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
    if (!_capabilitiesConfirmed || data.length == 0) {
        return;
    }
    if (!_streaming) {
        if (_lastVoiceStopTime > 0 &&
            CFAbsoluteTimeGetCurrent() - _lastVoiceStopTime < 0.3) {
            return;
        }
        [self beginVoiceSession];
    }
    [self emitEvent:AKAudioEventPacket
               data:data
             value1:(int)_frameSize
             value2:0];
}

- (BOOL)ensureAudioOutput {
    if (_engine.isRunning && _player.isPlaying) {
        return YES;
    }
    [self stopAudioOutput];
    AudioDeviceID deviceID = AKFindDriverDevice();
    if (deviceID == kAudioObjectUnknown) {
        [self setState:AKAudioStateDriverMissing error:nil];
        return NO;
    }

    AVAudioEngine *engine = [[AVAudioEngine alloc] init];
    AVAudioPlayerNode *player = [[AVAudioPlayerNode alloc] init];
    [engine attachNode:player];
    [engine connect:player to:engine.mainMixerNode format:_sourceFormat];
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
    NSError *startError = nil;
    [engine prepare];
    if (![engine startAndReturnError:&startError]) {
        [self setState:AKAudioStateError
                 error:[NSString stringWithFormat:@"Cannot start MiRemoteV 2ch: %@",
                                                   startError.localizedDescription ?: @"unknown error"]];
        return NO;
    }
    @try {
        [player play];
    } @catch (NSException *exception) {
        [engine stop];
        [self setState:AKAudioStateError
                 error:[NSString stringWithFormat:@"Cannot start audio playback: %@",
                                                   exception.reason ?: @"unknown exception"]];
        return NO;
    }
    _engine = engine;
    _player = player;
    return YES;
}

- (BOOL)enqueueSamples:(const int16_t *)samples count:(size_t)count {
    if (samples == NULL || count == 0 || ![self ensureAudioOutput]) {
        return NO;
    }
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc]
        initWithPCMFormat:_sourceFormat
        frameCapacity:(AVAudioFrameCount)count];
    if (buffer == nil || buffer.floatChannelData == NULL) {
        return NO;
    }
    float *channel = buffer.floatChannelData[0];
    float gain = 1.0f;
    @synchronized (self) {
        gain = _gain;
    }
    for (size_t index = 0; index < count; index++) {
        float value = ((float)samples[index] / (float)INT16_MAX) * gain;
        channel[index] = fminf(fmaxf(value, -1.0f), 1.0f);
    }
    buffer.frameLength = (AVAudioFrameCount)count;
    _pendingAudioBuffers += 1;
    __weak AKMacAudioBridge *weakSelf = self;
    [_player scheduleBuffer:buffer
                     atTime:nil
                     options:0
      completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack
           completionHandler:^(AVAudioPlayerNodeCompletionCallbackType callbackType) {
               if (callbackType != AVAudioPlayerNodeCompletionDataPlayedBack) {
                   return;
               }
               dispatch_async(dispatch_get_main_queue(), ^{
                   AKMacAudioBridge *strongSelf = weakSelf;
                   if (strongSelf == nil) {
                       return;
                   }
                   if (strongSelf->_pendingAudioBuffers > 0) {
                       strongSelf->_pendingAudioBuffers -= 1;
                   }
                   if (strongSelf->_pendingAudioBuffers == 0 &&
                       strongSelf->_drainRequested && !strongSelf->_streaming) {
                       [strongSelf stopAudioOutput];
                   }
               });
           }];
    return YES;
}

- (void)stopAudioOutput {
    _drainGeneration += 1;
    _drainRequested = NO;
    _pendingAudioBuffers = 0;
    [_player stop];
    [_engine stop];
    _player = nil;
    _engine = nil;
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
            [self setBatteryLevel:-1];
            return;
        }
        for (CBCharacteristic *characteristic in service.characteristics) {
            if (![characteristic.UUID isEqual:_batteryLevelUUID]) {
                continue;
            }
            _batteryLevelCharacteristic = characteristic;
            [peripheral readValueForCharacteristic:characteristic];
            CBCharacteristicProperties properties = characteristic.properties;
            if ((properties & CBCharacteristicPropertyNotify) != 0 ||
                (properties & CBCharacteristicPropertyIndicate) != 0) {
                [peripheral setNotifyValue:YES forCharacteristic:characteristic];
            }
            return;
        }
        [self setBatteryLevel:-1];
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
    if (peripheral == _peripheral &&
        [characteristic.UUID isEqual:_batteryLevelUUID]) {
        [self setBatteryLevel:error == nil ? AKParseBatteryLevel(characteristic.value) : -1];
        return;
    }
    if (peripheral != _peripheral || error != nil || characteristic.value == nil) {
        return;
    }
    if ([characteristic.UUID isEqual:_controlUUID]) {
        [self handleControlData:characteristic.value];
    } else if ([characteristic.UUID isEqual:_audioUUID]) {
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
