#import <Foundation/Foundation.h>
#import "../src-tauri/native/macos_audio.m"

@interface FakeAudioEngine : NSObject
@property(nonatomic) BOOL stopped;
@property(nonatomic) int starts;
@end
@implementation FakeAudioEngine
- (BOOL)isRunning { return !self.stopped; }
- (void)stop { self.stopped = YES; }
- (void)pause { self.stopped = YES; }
- (BOOL)startAndReturnError:(NSError **)error {
    self.stopped = NO;
    self.starts += 1;
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
    int reports, activeReports, lastWindow, sessionStops;
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
        events->activeReports += value1 != 0;
        events->lastWindow = value2;
    }
}
#define CHECK(condition, message) do { if (!(condition)) { fputs(message "\n", stderr); return 1; } } while (0)

int main(void) {
    @autoreleasepool {
        AudioEvents events = {0};
        AKAudioCallbacks callbacks = {.context = &events, .on_event = CaptureAudioEvent};
        AKMacAudioBridge *bridge = [[AKMacAudioBridge alloc] initWithCallbacks:&callbacks];
        [bridge handleAudioData:[NSData dataWithBytes:"\x11" length:1]];
        CHECK(events.received == 1 && events.rejected == 1, "rejected notification not counted");
        FakeAudioEngine *engine = [[FakeAudioEngine alloc] init];
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

        // Device changes must resume the same graph without discarding queued PCM.
        [bridge beginVoiceSession];
        CHECK([bridge enqueueSamples:samples count:4], "second enqueue failed");
        engine.stopped = YES;
        CHECK([bridge ensureAudioOutput], "output resume failed");
        CHECK([bridge valueForKey:@"engine"] == engine && engine.starts == 1 &&
              AKPCMQueueCount(&storage->queue) == 4, "resume replaced the graph or dropped PCM");
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
