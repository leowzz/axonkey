#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#import "../src-tauri/native/macos_audio.m"

@interface AKMacAudioBridge (TailDrainTest)
- (void)endVoiceSession;
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
@end

@implementation FakeAudioPlayer
- (BOOL)isPlaying {
    return YES;
}

- (void)stop {}

- (void)scheduleBuffer:(AVAudioPCMBuffer *)buffer
     completionHandler:(void (^)(void))completionHandler {
    self.playedBack = completionHandler;
}

- (void)scheduleBuffer:(AVAudioPCMBuffer *)buffer
                 atTime:(AVAudioTime *)when
                 options:(AVAudioPlayerNodeBufferOptions)options
  completionCallbackType:(AVAudioPlayerNodeCompletionCallbackType)callbackType
       completionHandler:(void (^)(AVAudioPlayerNodeCompletionCallbackType))completionHandler {
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

        int16_t samples[] = {100, 200, 300, 400};
        if (![bridge enqueueSamples:samples count:4]) {
            fputs("failed to enqueue the tail buffer\n", stderr);
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
