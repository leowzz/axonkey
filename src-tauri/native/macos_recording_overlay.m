#import <AppKit/AppKit.h>
#include <stdbool.h>

@interface AxonkeyRecordingButton : NSButton
@property(nonatomic, assign) void (*onClick)(void);
@end

@implementation AxonkeyRecordingButton
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)acceptsFirstResponder { return NO; }
- (void)stopRecording:(id)sender {
    if (self.onClick) self.onClick();
}
- (void)drawRect:(NSRect)dirtyRect {
    [[NSColor colorWithSRGBRed:39.0/255 green:46.0/255 blue:55.0/255 alpha:224.0/255] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:18 yRadius:18] fill];
    NSDictionary *attributes = @{
        NSFontAttributeName: [NSFont systemFontOfSize:13 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: [NSColor colorWithSRGBRed:241.0/255 green:246.0/255 blue:250.0/255 alpha:1]
    };
    NSSize textSize = [self.title sizeWithAttributes:attributes];
    CGFloat left = (NSWidth(self.bounds) - textSize.width - 46) / 2;
    [NSApp.applicationIconImage drawInRect:NSMakeRect(left, 8, 20, 20)
        fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1
        respectFlipped:YES hints:nil];
    [[NSColor colorWithSRGBRed:248.0/255 green:113.0/255 blue:113.0/255 alpha:1] setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(left + 28, 14, 8, 8)] fill];
    [self.title drawAtPoint:NSMakePoint(left + 46, (NSHeight(self.bounds) - textSize.height) / 2)
        withAttributes:attributes];
}
@end

@interface AxonkeyRecordingPanel : NSPanel
@end
@implementation AxonkeyRecordingPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

static AxonkeyRecordingPanel *recordingPanel;

// Invoked on Tauri's main thread; the panel must leave the input app focused.
void axonkey_macos_recording_overlay(bool visible, int width, int height, void (*onClick)(void)) {
    NSCAssert(NSThread.isMainThread, @"Recording notifications require AppKit's main thread");
    if (!visible) {
        [recordingPanel orderOut:nil];
        return;
    }
    if (!recordingPanel) {
        NSRect frame = NSMakeRect(0, 0, width, height);
        recordingPanel = [[AxonkeyRecordingPanel alloc] initWithContentRect:frame
            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
            backing:NSBackingStoreBuffered defer:NO];
        recordingPanel.title = @"正在录音 · Axonkey";
        recordingPanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorCanJoinAllApplications
            | NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorIgnoresCycle;
        recordingPanel.hidesOnDeactivate = NO;
        recordingPanel.floatingPanel = YES;
        recordingPanel.level = NSStatusWindowLevel;
        recordingPanel.opaque = NO;
        recordingPanel.backgroundColor = NSColor.clearColor;
        recordingPanel.hasShadow = NO;
        recordingPanel.animationBehavior = NSWindowAnimationBehaviorNone;
        recordingPanel.releasedWhenClosed = NO;

        AxonkeyRecordingButton *button = [[AxonkeyRecordingButton alloc] initWithFrame:frame];
        button.title = @"正在录音";
        button.bordered = NO;
        button.target = button;
        button.action = @selector(stopRecording:);
        button.onClick = onClick;
        button.toolTip = @"点击停止 A15 录音";
        button.accessibilityLabel = @"正在录音，点击停止 A15 录音";
        recordingPanel.contentView = button;
    }
    NSPoint mouse = NSEvent.mouseLocation;
    NSScreen *screen = NSScreen.screens.firstObject;
    for (NSScreen *candidate in NSScreen.screens) {
        if (NSPointInRect(mouse, candidate.frame)) { screen = candidate; break; }
    }
    NSRect area = screen.visibleFrame;
    [recordingPanel setFrame:NSMakeRect(NSMinX(area) + NSWidth(area) * 0.4 - width / 2.0,
        NSMinY(area) + NSHeight(area) * 0.2 - height / 2.0, width, height) display:YES];
    [recordingPanel orderFrontRegardless];
}
