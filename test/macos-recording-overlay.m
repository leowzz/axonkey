#import "../src-tauri/native/macos_recording_overlay.m"
#include <assert.h>
#include <stdio.h>

static unsigned int clicks;
static void clicked(void) { clicks++; }

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSWindow *keyWindow = NSApp.keyWindow;
        BOOL active = NSApp.active;
        axonkey_macos_recording_overlay(false, 160, 36, clicked);
        assert(recordingPanel == nil);
        axonkey_macos_recording_overlay(true, 160, 36, clicked);
        assert(recordingPanel.visible);
        assert(recordingPanel.onActiveSpace);
        assert(recordingPanel.styleMask & NSWindowStyleMaskNonactivatingPanel);
        assert(recordingPanel.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces);
        assert(recordingPanel.collectionBehavior & NSWindowCollectionBehaviorFullScreenAuxiliary);
        assert(recordingPanel.level == NSStatusWindowLevel);
        assert(!recordingPanel.canBecomeKeyWindow && !recordingPanel.canBecomeMainWindow);
        assert(!recordingPanel.ignoresMouseEvents && !recordingPanel.hidesOnDeactivate);
        assert(NSContainsRect(recordingPanel.screen.visibleFrame, recordingPanel.frame));
        AxonkeyRecordingButton *button = (AxonkeyRecordingButton *)recordingPanel.contentView;
        assert([button.title isEqualToString:@"正在录音"]);
        assert(button.accessibilityLabel.length > 0);
        assert([button acceptsFirstMouse:nil]);
        assert(!button.acceptsFirstResponder);
        [button performClick:nil];
        assert(clicks == 1);
        assert(NSApp.active == active && NSApp.keyWindow == keyWindow);

        NSBitmapImageRep *bitmap = [button bitmapImageRepForCachingDisplayInRect:button.bounds];
        [button cacheDisplayInRect:button.bounds toBitmapImageRep:bitmap];
        BOOL hasText = NO, hasRed = NO;
        for (NSInteger y = 0; y < bitmap.pixelsHigh; y++) {
            for (NSInteger x = bitmap.pixelsWide / 3; x < bitmap.pixelsWide; x++) {
                NSColor *color = [[bitmap colorAtX:x y:y] colorUsingColorSpace:NSColorSpace.deviceRGBColorSpace];
                hasText |= color.redComponent > 0.85 && color.greenComponent > 0.85 && color.blueComponent > 0.85;
                hasRed |= color.redComponent > 0.8 && color.greenComponent < 0.65 && color.blueComponent < 0.65;
            }
        }
        assert(hasText && hasRed);
        NSString *preview = NSProcessInfo.processInfo.environment[@"AXONKEY_RECORDING_PREVIEW"];
        if (preview) {
            NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            assert([png writeToFile:[preview stringByAppendingPathComponent:@"macos-recording.png"] atomically:YES]);
        }
        AxonkeyRecordingPanel *first = recordingPanel;
        axonkey_macos_recording_overlay(false, 160, 36, clicked);
        assert(!recordingPanel.visible);
        axonkey_macos_recording_overlay(true, 160, 36, clicked);
        assert(recordingPanel == first && recordingPanel.visible);
        [button performClick:nil];
        assert(clicks == 2);
        assert(NSApp.active == active && NSApp.keyWindow == keyWindow);
        axonkey_macos_recording_overlay(false, 160, 36, clicked);
        puts("native recording panel: nonactivating=1 clickable=1 rendering=1 reuse=1");
    }
    return 0;
}
