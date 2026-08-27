#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#import "../src-tauri/native/macos_audio.m"

@interface AKMacAudioBridge (TailDrainTest)
- (void)endVoiceSession;
- (void)setGainDecibels:(float)decibels;
@end

@interface FakeAudioEngine : NSObject
@property(nonatomic) BOOL stopped;
@end

@implementation FakeAudioEngine
- (BOOL)isRunning {
    return !self.stopped;
}

- (void)stop {
    self.stopped = YES;
}
@end

@interface FakeAudioPlayer : NSObject
@property(nonatomic, copy) void (^playedBack)(void);
@property(nonatomic, strong) AVAudioPCMBuffer *scheduledBuffer;
@end

@implementation FakeAudioPlayer
- (BOOL)isPlaying {
    return YES;
}

- (void)stop {}

- (void)scheduleBuffer:(AVAudioPCMBuffer *)buffer
     completionHandler:(void (^)(void))completionHandler {
    self.scheduledBuffer = buffer;
    self.playedBack = completionHandler;
}

- (void)scheduleBuffer:(AVAudioPCMBuffer *)buffer
                 atTime:(AVAudioTime *)when
                 options:(AVAudioPlayerNodeBufferOptions)options
       completionCallbackType:(AVAudioPlayerNodeCompletionCallbackType)callbackType
           completionHandler:(void (^)(AVAudioPlayerNodeCompletionCallbackType))completionHandler {
    self.scheduledBuffer = buffer;
    self.playedBack = ^{ completionHandler(AVAudioPlayerNodeCompletionDataPlayedBack); };
}
@end

static void PumpMainRunLoop(NSTimeInterval seconds) {
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

int main(void) {
    @autoreleasepool {
        AKMacAudioBridge *bridge = [[AKMacAudioBridge alloc] initWithCallbacks:NULL];
        FakeAudioEngine *engine = [[FakeAudioEngine alloc] init];
        FakeAudioPlayer *player = [[FakeAudioPlayer alloc] init];
        [bridge setValue:engine forKey:@"engine"];
        [bridge setValue:player forKey:@"player"];
        [bridge setValue:@YES forKey:@"streaming"];
        [bridge setGainDecibels:6.0f];

        int16_t samples[] = {100, 200, 30000, 400};
        if (![bridge enqueueSamples:samples count:4]) {
            fputs("failed to enqueue the tail buffer\n", stderr);
            return 1;
        }
        if (player.scheduledBuffer == nil || player.scheduledBuffer.floatChannelData == NULL) {
            fputs("gain test did not receive a PCM buffer\n", stderr);
            return 1;
        }
        float *channel = player.scheduledBuffer.floatChannelData[0];
        if (fabsf(channel[0] - (100.0f / (float)INT16_MAX) * powf(10.0f, 6.0f / 20.0f)) > 0.0001f || channel[2] != 1.0f) {
            fputs("audio gain was not applied with output limiting\n", stderr);
            return 1;
        }

        [bridge endVoiceSession];
        PumpMainRunLoop(0.5);
        if (engine.stopped) {
            fputs("audio output stopped before the tail buffer played back\n", stderr);
            return 1;
        }
        if (player.playedBack == nil) {
            fputs("tail buffer has no playback completion callback\n", stderr);
            return 1;
        }

        player.playedBack();
        PumpMainRunLoop(0.05);
        if (!engine.stopped) {
            fputs("audio output did not stop after the tail buffer played back\n", stderr);
            return 1;
        }
    }
    return 0;
}
