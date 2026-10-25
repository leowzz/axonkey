#import <Foundation/Foundation.h>
#import "../src-tauri/native/devices/xiaomi_remote/macos_audio.m"

@interface FakeAudioEngine : NSObject
@property(nonatomic) BOOL stopped;
@property(nonatomic) int starts;
@property(nonatomic) BOOL redirected;
@property(nonatomic) BOOL redirectOnStart;
@property(nonatomic) AudioDeviceID deviceID;
@property(nonatomic) BOOL failStart;
@property(nonatomic, copy) void (^onStart)(void);
@end
@implementation FakeAudioEngine
- (BOOL)isRunning { return !self.stopped; }
- (void)stop { self.stopped = YES; }
- (void)pause { self.stopped = YES; }
- (BOOL)startAndReturnError:(NSError **)error {
    if (self.onStart) self.onStart();
    if (self.failStart) return NO;
    self.stopped = NO;
    self.starts += 1;
    if (self.redirectOnStart) self.redirected = YES;
    return YES;
}
@end

// Exercise the real route guard without changing any system audio devices.
@interface RouteAudioBridge : AKMacAudioBridge
@property(nonatomic) int rebuilds;
@property(nonatomic) AudioDeviceID availableDeviceID;
@property(nonatomic) OSStatus selectStatus;
@property(nonatomic) BOOL ignoreSelection;
@property(nonatomic) int selections;
@end
@implementation RouteAudioBridge
- (instancetype)initWithCallbacks:(const AKAudioCallbacks *)callbacks {
    self = [super initWithCallbacks:callbacks];
    if (self) self.availableDeviceID = 113;
    return self;
}
- (AudioDeviceID)driverDeviceID { return self.availableDeviceID; }
- (OSStatus)selectOutputDevice:(AudioDeviceID)deviceID {
    self.selections += 1;
    if (self.selectStatus != noErr) return self.selectStatus;
    if (!self.ignoreSelection) {
        FakeAudioEngine *engine = [self valueForKey:@"engine"];
        engine.deviceID = deviceID;
        engine.redirected = NO;
    }
    return noErr;
}
- (BOOL)outputTargetsDriver {
    FakeAudioEngine *engine = [self valueForKey:@"engine"];
    return engine != nil && !engine.redirected &&
           engine.deviceID == self.availableDeviceID &&
           engine.deviceID == [[self valueForKey:@"outputDeviceID"] unsignedIntValue];
}
- (BOOL)createAudioOutput {
    self.rebuilds += 1;
    FakeAudioEngine *engine = [[FakeAudioEngine alloc] init];
    engine.deviceID = self.availableDeviceID;
    [self setValue:engine forKey:@"engine"];
    [self setValue:@(self.availableDeviceID) forKey:@"outputDeviceID"];
    [self setValue:[[NSObject alloc] init] forKey:@"sourceNode"];
    AKAudioPCMStorage *storage = [[AKAudioPCMStorage alloc] init];
    atomic_store(&storage->outputVerified, true);
    [self setValue:storage forKey:@"pcmStorage"];
    return YES;
}
@end

// Replace hardware discovery, keeping the real restart/teardown lifecycle.
@interface RestartAudioBridge : AKMacAudioBridge
@property(nonatomic) BOOL failOutput;
@property(nonatomic) int reconnects;
@end
@implementation RestartAudioBridge
- (BOOL)ensureAudioOutput {
    if (self.failOutput) {
        [self setState:AKAudioStateError error:@"output selection failed"];
        return NO;
    }
    [self setValue:[[FakeAudioEngine alloc] init] forKey:@"engine"];
    [self setValue:[[NSObject alloc] init] forKey:@"sourceNode"];
    [self setValue:[[AKAudioPCMStorage alloc] init] forKey:@"pcmStorage"];
    return YES;
}
- (void)refresh { self.reconnects += 1; }
@end

static void PumpMainRunLoop(NSTimeInterval seconds) {
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

typedef struct {
    int received, rejected, renderedSamples, discardedBuffers;
    int reports, activeReports, lastWindow, sessionStops, lastFlags;
    char lastReport[4096];
} AudioEvents;
static void CaptureAudioEvent(void *context, int event, const uint8_t *data,
                              size_t length, int value1, int value2) {
    AudioEvents *events = context;
    if (event == AKAudioEventReceived) events->received++;
    if (event == AKAudioEventRejected) events->rejected++;
    if (event == AKAudioEventRendered) events->renderedSamples += value1;
    if (event == AKAudioEventOutputReset) events->discardedBuffers += value1;
    if (event == AKAudioEventSessionStop) events->sessionStops++;
    if (event == AKAudioEventDiagnostics) {
        events->reports++;
        events->activeReports += (value1 & 1) != 0;
        events->lastFlags = value1;
        size_t copied = MIN(length, sizeof(events->lastReport) - 1);
        memcpy(events->lastReport, data, copied);
        events->lastReport[copied] = 0;
        events->lastWindow = value2;
    }
}
#define CHECK(condition, message) do { if (!(condition)) { fputs(message "\n", stderr); return 1; } } while (0)

@interface FakeAudioCharacteristic : NSObject
@property(nonatomic, strong) CBUUID *UUID;
@property(nonatomic, strong) NSData *value;
@end
@implementation FakeAudioCharacteristic
@end

static int CheckWindowDiagnostics(void) {
    AudioEvents events = {0};
    AKAudioCallbacks callbacks = {.context = &events, .on_event = CaptureAudioEvent};
    RouteAudioBridge *bridge = [[RouteAudioBridge alloc] initWithCallbacks:&callbacks];
    NSObject *remote = [[NSObject alloc] init];
    [bridge setValue:remote forKey:@"peripheral"];
    FakeAudioCharacteristic *audio = [[FakeAudioCharacteristic alloc] init];
    audio.UUID = [bridge valueForKey:@"audioUUID"];
    audio.value = [NSMutableData dataWithLength:120];
    void (^deliver)(id, NSError *) = ^(id peripheral, NSError *error) {
        [bridge peripheral:peripheral didUpdateValueForCharacteristic:(id)audio error:error];
    };
    deliver([[NSObject alloc] init], nil); // Stale connection must not reach decoding.
    deliver(remote, [NSError errorWithDomain:@"test" code:1 userInfo:nil]);
    audio.value = nil;
    deliver(remote, nil);
    audio.value = [NSMutableData dataWithLength:120];
    deliver(remote, nil); // Not ready.
    [bridge setValue:@YES forKey:@"capabilitiesConfirmed"];
    audio.value = [NSData data];
    deliver(remote, nil);
    audio.value = [NSMutableData dataWithLength:120];
    [bridge setValue:@(CFAbsoluteTimeGetCurrent()) forKey:@"lastVoiceStopTime"];
    deliver(remote, nil);
    [bridge reportDiagnostics];
    CHECK(events.lastFlags == 2 && events.received == 3 && events.rejected == 3,
          "native-only activity or rejection behavior changed");
    NSString *report = @(events.lastReport);
    for (NSString *field in @[@"audio_callbacks=6", @"callback_bytes=480",
          @"notification_min_bytes=0 notification_max_bytes=120", @"callback_stale=1",
          @"callback_read_errors=1", @"callback_missing_value=1", @"rejected_not_ready=1",
          @"rejected_empty=1", @"rejected_after_stop=1", @"accepted_packets=0",
          @"callback_wait_ms=unknown transport_arrival=unknown"])
        CHECK([report containsString:field], "callback rejection diagnostic missing");
    [bridge reportDiagnostics];
    CHECK(events.lastFlags == 0 && strstr(events.lastReport, "audio_callbacks=0"),
          "window counters leaked into the next idle window");

    [bridge setValue:@0 forKey:@"lastVoiceStopTime"];
    deliver(remote, nil); // Starts a new session, no inter-session gap.
    [bridge setValue:@(NSProcessInfo.processInfo.systemUptime - 0.3) forKey:@"lastAudioCallbackTime"];
    deliver(remote, nil);
    [bridge reportDiagnostics];
    CHECK(strstr(events.lastReport, "accepted_packets=2 accepted_bytes=240") &&
          strstr(events.lastReport, "callback_gap_ge20=1 callback_gap_ge50=1 callback_gap_ge100=1 callback_gap_ge250=1"),
          "accepted callbacks or in-session gap not recorded");
    CHECK(events.received == 5 && events.rejected == 3, "telemetry changed accepted packet behavior");
    int16_t pcm[AKPCMCapacity + 1] = {0};
    CHECK(![bridge enqueueSamples:NULL count:1], "invalid enqueue accepted");
    CHECK(![bridge enqueueSamples:pcm count:AKPCMCapacity + 1], "oversized enqueue accepted");
    CHECK([bridge enqueueSamples:pcm count:480], "diagnostic test enqueue failed");
    AKAudioPCMStorage *storage = [bridge valueForKey:@"pcmStorage"];
    float output[100];
    CHECK(AKRenderAudio(storage, output, 100) == 100, "partial render failed");
    FakeAudioEngine *engine = [bridge valueForKey:@"engine"];
    engine.stopped = YES;
    bridge.availableDeviceID = kAudioObjectUnknown;
    CHECK(![bridge enqueueSamples:pcm count:1], "unavailable output accepted PCM");
    [bridge reportDiagnostics];
    CHECK(strstr(events.lastReport, "enqueue_invalid=1 enqueue_output_unavailable=1 enqueue_queue_full=1"),
          "enqueue failure causes were not distinguished");
    CHECK(strstr(events.lastReport, "discarded_queued_samples=380") && events.discardedBuffers == 1,
          "queue discard counted already rendered samples");
    [bridge setValue:nil forKey:@"peripheral"];
    [bridge stop];
    CHECK(strstr(events.lastReport, "discarded_queued_samples=0"), "discard window did not reset");

    // Thresholds are inclusive and cumulative, not disjoint buckets.
    AKAudioWindow w = {0};
    for (double ms = 0; ms <= 250; ms += 10) AKRecordCallbackGap(&w, ms);
    CHECK(w.gap20 == 24 && w.gap50 == 21 && w.gap100 == 16 && w.gap250 == 1,
          "callback gap thresholds incorrect");
    return 0;
}

static int CheckStretchConfiguration(void) {
    RouteAudioBridge *bridge = [[RouteAudioBridge alloc] initWithCallbacks:NULL];
    CHECK([bridge ensureAudioOutput], "stretch fixture output failed");
    AKAudioPCMStorage *storage = [bridge valueForKey:@"pcmStorage"];
    CHECK(!storage->queue.stretchEnabled, "stretch must default off");
    CHECK(axonkey_macos_audio_set_stretch_compensation((__bridge void *)bridge, true), "idle stretch enable failed");
    CHECK(storage->queue.stretchEnabled, "stretch setting did not reach render queue");
    [bridge beginVoiceSession];
    int16_t samples[960] = {0};
    CHECK([bridge enqueueSamples:samples count:960], "stretch enqueue failed");
    CHECK(![bridge setStretchCompensation:NO] && storage->queue.stretchEnabled &&
          AKPCMQueueCount(&storage->queue) == 960, "active toggle modified or discarded queued audio");
    [bridge endVoiceSession];
    CHECK(![bridge setStretchCompensation:NO], "toggle discarded unplayed tail");
    float output[128];
    for (int i = 0; i < 30 && AKPCMQueueCount(&storage->queue); i++) AKRenderAudio(storage, output, 128);
    [bridge collectRenderedAudio];
    CHECK(AKPCMQueueCount(&storage->queue) == 0, "stretch tail remained queued");
    CHECK([bridge setStretchCompensation:NO] && !storage->queue.stretchEnabled,
          "could not restore normal playback after drain");
    CHECK([bridge setStretchCompensation:YES], "re-enable failed");
    [bridge resetAudioQueue];
    CHECK(storage->queue.stretchEnabled, "output reset lost configured compensation");
    [bridge stop];
    return 0;
}

static int CheckMonitorSnapshots(void) {
    RouteAudioBridge *bridge = [[RouteAudioBridge alloc] initWithCallbacks:NULL];
    CHECK([bridge ensureAudioOutput], "monitor fixture failed");
    [bridge beginVoiceSession];
    int16_t samples[AKPCMCapacity] = {0};
    float output[AKPCMCapacity];
    AKMonitorSnapshot before, full, drained, reset;
    [bridge readMonitor:&before];
    CHECK([bridge enqueueSamples:samples count:AKPCMCapacity], "full queue enqueue failed");
    CHECK(![bridge enqueueSamples:samples count:240], "full queue should reject input");
    [bridge readMonitor:&full];
    CHECK(full.queued == AKPCMCapacity && full.peak == AKPCMCapacity && full.full == before.full + 1,
          "monitor missed capacity or rejection");
    AKAudioPCMStorage *storage = [bridge valueForKey:@"pcmStorage"];
    CHECK(AKRenderAudio(storage, output, AKPCMCapacity) == AKPCMCapacity, "queue did not empty");
    [bridge readMonitor:&drained];
    CHECK(drained.queued == 0 && drained.emptied == full.emptied + 1 && drained.underruns == full.underruns + 1,
          "monitor missed transient empty/underrun");
    // Reading telemetry cannot reset the actual PCM or the logging counters.
    CHECK([bridge enqueueSamples:samples count:240], "tail enqueue failed");
    [bridge readMonitor:&reset];
    CHECK(AKPCMQueueCount(&storage->queue) == 240 && atomic_load(&storage->queue.underruns) == 1,
          "monitor altered playback or diagnostics");
    [bridge resetAudioQueue];
    [bridge readMonitor:&reset];
    CHECK(reset.resets == drained.resets + 1 && reset.discarded == drained.discarded + 240 &&
          reset.emptied == drained.emptied && reset.underruns == drained.underruns,
          "reset lost counters or pretended discarded audio was played");
    [bridge stop];
    return 0;
}

int main(void) {
    @autoreleasepool {
        CHECK(CheckMonitorSnapshots() == 0, "queue monitor snapshots failed");
        CHECK(CheckStretchConfiguration() == 0, "stretch settings failed");
        CHECK(CheckWindowDiagnostics() == 0, "window diagnostics failed");
        AudioEvents events = {0};
        AKAudioCallbacks callbacks = {.context = &events, .on_event = CaptureAudioEvent};
        RouteAudioBridge *bridge = [[RouteAudioBridge alloc] initWithCallbacks:&callbacks];
        [bridge handleAudioData:[NSData dataWithBytes:"\x11" length:1]];
        CHECK(events.received == 1 && events.rejected == 1, "rejected notification not counted");
        FakeAudioEngine *engine = [[FakeAudioEngine alloc] init];
        engine.deviceID = bridge.availableDeviceID;
        [bridge setValue:@(engine.deviceID) forKey:@"outputDeviceID"];
        AKAudioPCMStorage *storage = [[AKAudioPCMStorage alloc] init];
        [bridge setValue:engine forKey:@"engine"];
        [bridge setValue:[[NSObject alloc] init] forKey:@"sourceNode"];
        [bridge setValue:storage forKey:@"pcmStorage"];
        [bridge beginVoiceSession];
        [bridge startDiagnostics];
        [bridge startDiagnostics];
        PumpMainRunLoop(1.1);
        CHECK(events.reports == 1 && events.activeReports == 1 && events.lastWindow >= 900,
              "silent active session did not produce one diagnostic event");
        [bridge setGainDecibels:6];
        int16_t samples[] = {100, 200, 30000, 400};
        CHECK([bridge enqueueSamples:samples count:4], "enqueue failed");
        CHECK(fabsf(storage->queue.samples[0] - 100.0f / 32768.0f * powf(10, 0.3f)) < 0.0001f &&
              storage->queue.samples[2] == 1, "gain or clipping is incorrect");
        CHECK([[bridge valueForKey:@"clippedSamples"] intValue] == 1, "clipping not counted");
        float output[512];
        CHECK(AKPCMQueueRender(&storage->queue, output, 512) == 0, "short packet bypassed prebuffer");
        [bridge endVoiceSession];
        PumpMainRunLoop(0.1);
        CHECK(!engine.stopped && events.renderedSamples == 0, "tail was discarded before render");
        CHECK(AKPCMQueueRender(&storage->queue, output, 512) == 4, "short tail did not drain");
        PumpMainRunLoop(0.05);
        CHECK(events.renderedSamples == 4 && events.discardedBuffers == 0 && !engine.stopped,
              "tail metrics or warm output incorrect");
        CHECK(![[bridge valueForKey:@"drainRequested"] boolValue], "tail drain did not finish");

        // A paused graph still targeting MiRemoteV preserves queued PCM.
        [bridge beginVoiceSession];
        CHECK([bridge enqueueSamples:samples count:4], "second enqueue failed");
        engine.stopped = YES;
        CHECK([bridge ensureAudioOutput], "output resume failed");
        CHECK([bridge valueForKey:@"engine"] == engine && engine.starts == 1 &&
              AKPCMQueueCount(&storage->queue) == 4 && bridge.selections == 1,
              "resume failed to rebind or replaced the graph/dropped PCM");
        [bridge endVoiceSession];
        AKPCMQueueRender(&storage->queue, output, 512);
        PumpMainRunLoop(0.05);
        CHECK(events.renderedSamples == 8, "second tail not rendered");
        [bridge collectRenderedAudio];
        CHECK(events.renderedSamples == 8, "rendered samples were double counted");
        [bridge beginVoiceSession];
        [bridge endVoiceSession];
        PumpMainRunLoop(5.1);
        CHECK(engine.stopped && [bridge valueForKey:@"engine"] == engine,
              "idle output did not pause while retaining its graph");
        [bridge beginVoiceSession];
        CHECK(!engine.stopped && engine.starts == 2, "idle output did not resume");
        [bridge enqueueSamples:samples count:4];
        [bridge enqueueSamples:samples count:4];
        [bridge stopAudioOutput];
        CHECK(events.discardedBuffers == 2 && engine.stopped, "shutdown did not discard pending PCM");
        PumpMainRunLoop(0.05);
        CHECK(events.renderedSamples == 8, "stale render poll counted a discarded buffer");
        [bridge stop];
        int reports = events.reports;
        PumpMainRunLoop(1.1);
        CHECK(events.reports == reports, "diagnostic timer survived shutdown");

        // A running graph redirected to speakers must be stopped before enqueue.
        RouteAudioBridge *routeBridge = [[RouteAudioBridge alloc] initWithCallbacks:NULL];
        CHECK([routeBridge ensureAudioOutput], "initial output creation failed");
        FakeAudioEngine *redirectedEngine = [routeBridge valueForKey:@"engine"];
        AKAudioPCMStorage *oldStorage = [routeBridge valueForKey:@"pcmStorage"];
        redirectedEngine.redirected = YES;
        CHECK([routeBridge enqueueSamples:samples count:4], "route recovery failed");
        CHECK(redirectedEngine.stopped && routeBridge.rebuilds == 2 &&
              AKPCMQueueCount(&oldStorage->queue) == 0,
              "speech was enqueued into the redirected graph");
        AKAudioPCMStorage *newStorage = [routeBridge valueForKey:@"pcmStorage"];
        CHECK(AKPCMQueueCount(&newStorage->queue) == 4, "recovered output lost new speech");

        // A driver reload changes its numeric ID; the old ID now belongs to
        // another device. Re-resolve by identity and bind before starting.
        FakeAudioEngine *reloadedEngine = [routeBridge valueForKey:@"engine"];
        reloadedEngine.stopped = YES;
        routeBridge.availableDeviceID = 211;
        __block BOOL silentAtStart = NO;
        reloadedEngine.onStart = ^{
            float startup[512];
            atomic_store(&newStorage->queue.draining, true);
            size_t consumed = AKRenderAudio(newStorage, startup, 512);
            silentAtStart = consumed == 0 && AKPCMQueueCount(&newStorage->queue) == 4;
            for (int i = 0; i < 512; i++) silentAtStart &= startup[i] == 0;
        };
        CHECK([routeBridge ensureAudioOutput] && reloadedEngine.deviceID == 211 &&
              reloadedEngine.starts == 1 && routeBridge.rebuilds == 2 && silentAtStart,
              "resume used stale ID, discarded PCM, or rendered before route verification");
        CHECK(AKRenderAudio(newStorage, output, 512) == 4,
              "verified route did not release preserved PCM");
        reloadedEngine.onStart = nil;

        // Starting an apparently correct paused graph can itself redirect it.
        FakeAudioEngine *resumeEngine = [routeBridge valueForKey:@"engine"];
        resumeEngine.stopped = YES;
        resumeEngine.redirectOnStart = YES;
        CHECK([routeBridge ensureAudioOutput] && resumeEngine.stopped &&
              routeBridge.rebuilds == 3 && [routeBridge outputTargetsDriver],
              "resume accepted a redirected output device");
        [routeBridge stop];

        // Missing device, rejected bind, failed read-back, and failed start
        // must leave no live output and must not accept new microphone samples.
        for (int failure = 0; failure < 4; failure++) {
            RouteAudioBridge *failed = [[RouteAudioBridge alloc] initWithCallbacks:NULL];
            CHECK([failed ensureAudioOutput], "failure fixture creation failed");
            FakeAudioEngine *paused = [failed valueForKey:@"engine"];
            AKAudioPCMStorage *failedStorage = [failed valueForKey:@"pcmStorage"];
            paused.stopped = YES;
            if (failure == 0) failed.availableDeviceID = kAudioObjectUnknown;
            if (failure == 1) failed.selectStatus = kAudio_ParamError;
            if (failure == 2) { paused.redirected = YES; failed.ignoreSelection = YES; }
            if (failure == 3) paused.failStart = YES;
            CHECK(![failed enqueueSamples:samples count:4] && paused.stopped &&
                  [failed valueForKey:@"engine"] == nil &&
                  !atomic_load(&failedStorage->outputVerified) &&
                  AKPCMQueueCount(&failedStorage->queue) == 0,
                  "failed restore retained output or accepted speech");
            CHECK([failed currentState] == (failure == 0 ? AKAudioStateDriverMissing : AKAudioStateError),
                  "restore failure was not surfaced");
            CHECK(paused.starts == 0, "failed binding started the engine");
            [failed stop];
        }

        RestartAudioBridge *restartBridge = [[RestartAudioBridge alloc] initWithCallbacks:&callbacks];
        FakeAudioEngine *oldEngine = [[FakeAudioEngine alloc] init];
        [restartBridge setValue:oldEngine forKey:@"engine"];
        [restartBridge setValue:storage forKey:@"pcmStorage"];
        [restartBridge setValue:@YES forKey:@"streaming"];
        [restartBridge setValue:@YES forKey:@"capabilitiesConfirmed"];
        [restartBridge setValue:@2 forKey:@"pendingAudioBuffers"];
        [restartBridge setGainDecibels:6];
        int stops = events.sessionStops;
        int discarded = events.discardedBuffers;
        CHECK(axonkey_macos_audio_restart((__bridge void *)restartBridge), "manual restart failed");
        CHECK(oldEngine.stopped && [restartBridge valueForKey:@"engine"] != oldEngine &&
              [restartBridge valueForKey:@"pcmStorage"] != storage,
              "restart reused the old output or PCM queue");
        CHECK(events.sessionStops > stops && events.discardedBuffers == discarded + 2 &&
              ![restartBridge isForwarding] &&
              ![[restartBridge valueForKey:@"capabilitiesConfirmed"] boolValue],
              "restart did not clear the old voice session");
        CHECK(restartBridge.reconnects == 1 && [restartBridge currentState] == AKAudioStateScanning,
              "restart did not request reconnection or prematurely claimed readiness");
        CHECK(fabsf([[restartBridge valueForKey:@"gain"] floatValue] - powf(10, 0.3f)) < 0.0001f,
              "restart lost the configured gain");
        restartBridge.failOutput = YES;
        CHECK(!axonkey_macos_audio_restart((__bridge void *)restartBridge) &&
              [[restartBridge currentError] isEqualToString:@"output selection failed"] &&
              [restartBridge valueForKey:@"engine"] == nil && restartBridge.reconnects == 1,
              "output selection failure was hidden or reused stale output");
        restartBridge.failOutput = NO;
        CHECK(axonkey_macos_audio_restart((__bridge void *)restartBridge) &&
              [restartBridge currentError] == nil && restartBridge.reconnects == 2,
              "restart could not recover after output failure");
        [restartBridge stop];
    }
    return 0;
}
