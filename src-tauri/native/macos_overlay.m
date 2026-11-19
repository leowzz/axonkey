#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <math.h>
#include <stdbool.h>

@interface AxonkeyProfileSwitchPanel : NSPanel
@property(nonatomic, strong) NSTextField *deviceLabel;
@property(nonatomic, strong) NSTextField *fromLabel;
@property(nonatomic, strong) NSTextField *toLabel;
@property(nonatomic, strong) NSTextField *arrowLabel;
@end

@implementation AxonkeyProfileSwitchPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

static AxonkeyProfileSwitchPanel *profileSwitchPanel;
static uint64_t profileSwitchRevision;

static NSTextField *profileSwitchLabel(NSString *text, CGFloat size, NSFontWeight weight, CGFloat alpha) {
    NSTextField *label = [NSTextField labelWithString:text];
    label.font = [NSFont systemFontOfSize:size weight:weight];
    label.textColor = [NSColor colorWithWhite:1.0 alpha:alpha];
    label.lineBreakMode = NSLineBreakByTruncatingTail;
    return label;
}

static AxonkeyProfileSwitchPanel *createProfileSwitchPanel(void) {
    NSRect frame = NSMakeRect(0, 0, 420, 100);
    AxonkeyProfileSwitchPanel *panel = [[AxonkeyProfileSwitchPanel alloc]
        initWithContentRect:frame
        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    panel.title = @"配置已切换 · Axonkey";
    // Move the notification to the active Space on each show. A regular app
    // window cannot reliably float over another application's full-screen Space.
    panel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace
        | NSWindowCollectionBehaviorCanJoinAllApplications
        | NSWindowCollectionBehaviorFullScreenAuxiliary
        | NSWindowCollectionBehaviorStationary
        | NSWindowCollectionBehaviorIgnoresCycle;
    panel.hidesOnDeactivate = NO;
    panel.ignoresMouseEvents = YES;
    panel.floatingPanel = YES;
    // floatingPanel changes the level, so set the final z-order afterwards.
    panel.level = NSStatusWindowLevel;
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = NO;
    panel.animationBehavior = NSWindowAnimationBehaviorNone;
    panel.releasedWhenClosed = NO;

    NSView *root = [[NSView alloc] initWithFrame:frame];
    root.wantsLayer = YES;
    root.layer.cornerRadius = 16;
    root.layer.masksToBounds = YES;
    NSVisualEffectView *blur = [[NSVisualEffectView alloc] initWithFrame:frame];
    blur.material = NSVisualEffectMaterialHUDWindow;
    blur.state = NSVisualEffectStateActive;
    blur.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    [root addSubview:blur];
    NSView *tint = [[NSView alloc] initWithFrame:frame];
    tint.wantsLayer = YES;
    tint.layer.backgroundColor = [NSColor colorWithSRGBRed:24.0/255 green:29.0/255 blue:38.0/255 alpha:0.36].CGColor;
    tint.layer.borderWidth = 1;
    tint.layer.borderColor = [NSColor colorWithWhite:1 alpha:0.20].CGColor;
    tint.layer.cornerRadius = 16;
    [root addSubview:tint];

    NSImageView *icon = [[NSImageView alloc] initWithFrame:NSMakeRect(24, 38, 24, 24)];
    icon.image = [NSImage imageWithSystemSymbolName:@"square.3.layers.3d" accessibilityDescription:nil];
    icon.contentTintColor = [NSColor colorWithSRGBRed:0.77 green:0.85 blue:1 alpha:1];
    [root addSubview:icon];
    NSTextField *title = profileSwitchLabel(@"配置已切换", 12, NSFontWeightMedium, 0.72);
    title.frame = NSMakeRect(64, 62, 332, 18);
    [root addSubview:title];
    panel.deviceLabel = title;
    panel.fromLabel = profileSwitchLabel(@"", 17, NSFontWeightRegular, 0.75);
    panel.arrowLabel = profileSwitchLabel(@"→", 17, NSFontWeightRegular, 1);
    panel.toLabel = profileSwitchLabel(@"", 17, NSFontWeightSemibold, 1);
    [root addSubview:panel.fromLabel];
    [root addSubview:panel.arrowLabel];
    [root addSubview:panel.toLabel];
    panel.contentView = root;
    return panel;
}

static NSScreen *axonkey_screen_for_mouse(void) {
    NSArray<NSScreen *> *screens = NSScreen.screens;
    if (screens.count == 0) return NSScreen.mainScreen;
    NSPoint mouse = NSEvent.mouseLocation;
    NSScreen *best = screens.firstObject;
    CGFloat bestDistSq = CGFLOAT_MAX;
    for (NSScreen *candidate in screens) {
        NSRect f = candidate.frame;
        CGFloat dx = 0.0;
        if (mouse.x < NSMinX(f)) dx = NSMinX(f) - mouse.x;
        else if (mouse.x > NSMaxX(f)) dx = mouse.x - NSMaxX(f);
        CGFloat dy = 0.0;
        if (mouse.y < NSMinY(f)) dy = NSMinY(f) - mouse.y;
        else if (mouse.y > NSMaxY(f)) dy = mouse.y - NSMaxY(f);
        CGFloat distSq = dx * dx + dy * dy;
        if (distSq == 0.0) return candidate;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            best = candidate;
        }
    }
    return best;
}

// AppKit main thread only. Rendering and expiry do not depend on a hidden
// WebView running JavaScript in another desktop.
unsigned int axonkey_show_profile_switch_overlay(const char *device, const char *from, const char *to) {
    NSCAssert(NSThread.isMainThread, @"Profile notifications require AppKit's main thread");
    if (!profileSwitchPanel) profileSwitchPanel = createProfileSwitchPanel();
    AxonkeyProfileSwitchPanel *panel = profileSwitchPanel;
    [panel orderOut:nil];
    panel.deviceLabel.stringValue = [NSString stringWithFormat:@"%@ · 配置已切换", [NSString stringWithUTF8String:device] ?: @""];
    panel.fromLabel.stringValue = [NSString stringWithUTF8String:from] ?: @"";
    panel.toLabel.stringValue = [NSString stringWithUTF8String:to] ?: @"";
    CGFloat fromWidth = MIN(142, panel.fromLabel.fittingSize.width);
    panel.fromLabel.frame = NSMakeRect(64, 24, fromWidth, 26);
    panel.arrowLabel.frame = NSMakeRect(64 + fromWidth + 12, 24, 18, 26);
    panel.toLabel.frame = NSMakeRect(64 + fromWidth + 42, 24, 332 - fromWidth - 42, 26);

    NSScreen *screen = axonkey_screen_for_mouse();
    NSRect area = screen.visibleFrame;
    [panel setFrame:NSMakeRect(NSMidX(area) - 210, NSMinY(area) + NSHeight(area) * 0.25 - 50, 420, 100) display:YES];
    [panel orderFrontRegardless];

    uint64_t revision = ++profileSwitchRevision;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (revision == profileSwitchRevision) [profileSwitchPanel orderOut:nil];
    });
    return (panel.visible ? 1u : 0u) | (panel.onActiveSpace ? 2u : 0u);
}

// Non-activating NSPanel host for QuickOverlay's WKWebView. A regular NSWindow
// cannot appear over another application's full-screen Space without switching Spaces.
@interface AxonkeyQuickOverlayPanel : NSPanel
@end

@implementation AxonkeyQuickOverlayPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
- (BOOL)worksWhenModal { return YES; }
@end

static AxonkeyQuickOverlayPanel *quickOverlayPanel;
static __weak NSWindow *quickOverlaySourceWindow;
static id quickOverlayGlobalEscapeMonitor;
static id quickOverlayLocalEscapeMonitor;

static AxonkeyQuickOverlayPanel *ensureQuickOverlayPanel(NSWindow *tauriWindow, double width, double height) {
    if (!quickOverlayPanel) {
        NSRect initialFrame = NSMakeRect(0, 0, MAX((CGFloat)width, 320.0), MAX((CGFloat)height, 240.0));
        AxonkeyQuickOverlayPanel *panel = [[AxonkeyQuickOverlayPanel alloc]
            initWithContentRect:initialFrame
            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
            backing:NSBackingStoreBuffered
            defer:NO];
        panel.title = @"快捷交互窗 · Axonkey";
        panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehaviorCanJoinAllApplications
            | NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehaviorFullScreenDisallowsTiling
            | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorIgnoresCycle;
        panel.hidesOnDeactivate = NO;
        panel.floatingPanel = YES;
        // Set final level AFTER floatingPanel = YES (which resets level to NSFloatingWindowLevel).
        panel.level = NSScreenSaverWindowLevel;
        panel.opaque = NO;
        panel.backgroundColor = NSColor.clearColor;
        panel.hasShadow = NO;
        panel.movable = NO;
        panel.animationBehavior = NSWindowAnimationBehaviorNone;
        panel.releasedWhenClosed = NO;
        quickOverlayPanel = panel;
    }

    if (tauriWindow && quickOverlaySourceWindow != tauriWindow) {
        NSView *webContent = tauriWindow.contentView;
        if (webContent && webContent != quickOverlayPanel.contentView) {
            [tauriWindow orderOut:nil];
            tauriWindow.alphaValue = 0.0;
            tauriWindow.ignoresMouseEvents = YES;
            tauriWindow.contentView = [[NSView alloc] initWithFrame:NSZeroRect];
            webContent.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
            webContent.frame = NSMakeRect(0, 0, NSWidth(quickOverlayPanel.frame), NSHeight(quickOverlayPanel.frame));
            quickOverlayPanel.contentView = webContent;
            for (NSView *subview in webContent.subviews) {
                subview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
                subview.frame = webContent.bounds;
            }
        }
        quickOverlaySourceWindow = tauriWindow;
    }
    return quickOverlayPanel;
}

void axonkey_configure_quick_overlay_window(void *window_ptr, bool (*onEscape)(void)) {
    NSCAssert(NSThread.isMainThread, @"Quick overlay configuration requires AppKit's main thread");
    if (!window_ptr) return;
    NSWindow *tauriWindow = (__bridge NSWindow *)window_ptr;
    (void)ensureQuickOverlayPanel(tauriWindow, 880.0, 560.0);
    // The panel cannot become key, so Escape normally goes to the foreground app.
    if (!quickOverlayGlobalEscapeMonitor) {
        quickOverlayGlobalEscapeMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown
            handler:^(NSEvent *event) {
                if (event.keyCode == 53) onEscape();
            }];
    }
    if (!quickOverlayLocalEscapeMonitor) {
        quickOverlayLocalEscapeMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
            handler:^NSEvent *(NSEvent *event) {
                if (event.keyCode == 53 && onEscape()) return nil;
                return event;
            }];
    }
}

unsigned int axonkey_show_quick_overlay_window(void *window_ptr, double width, double height) {
    NSCAssert(NSThread.isMainThread, @"Quick overlay presentation requires AppKit's main thread");
    if (!window_ptr) return 0;
    NSWindow *tauriWindow = (__bridge NSWindow *)window_ptr;
    AxonkeyQuickOverlayPanel *panel = ensureQuickOverlayPanel(tauriWindow, width, height);

    NSScreen *screen = axonkey_screen_for_mouse();
    if (screen) {
        NSRect screenFrame = screen.frame;
        NSRect visible = screen.visibleFrame;
        NSRect area = (NSWidth(visible) >= 320.0 && NSHeight(visible) >= 240.0) ? visible : screenFrame;
        CGFloat w = MIN((CGFloat)width, MAX(320.0, NSWidth(area) - 32.0));
        CGFloat h = MIN((CGFloat)height, MAX(240.0, NSHeight(area) - 32.0));
        NSRect frame = NSMakeRect(
            NSMinX(area) + floor((NSWidth(area) - w) * 0.5),
            NSMinY(area) + floor((NSHeight(area) - h) * 0.5 + 12.0),
            w,
            h
        );
        if (NSMaxX(frame) > NSMaxX(screenFrame) - 8.0) frame.origin.x = NSMaxX(screenFrame) - w - 8.0;
        if (NSMinX(frame) < NSMinX(screenFrame) + 8.0) frame.origin.x = NSMinX(screenFrame) + 8.0;
        if (NSMaxY(frame) > NSMaxY(screenFrame) - 8.0) frame.origin.y = NSMaxY(screenFrame) - h - 8.0;
        if (NSMinY(frame) < NSMinY(screenFrame) + 8.0) frame.origin.y = NSMinY(screenFrame) + 8.0;

        [panel setFrame:frame display:YES];
        if (panel.contentView) {
            panel.contentView.frame = NSMakeRect(0, 0, w, h);
            for (NSView *subview in panel.contentView.subviews) {
                subview.frame = NSMakeRect(0, 0, w, h);
            }
        }
    }

    panel.level = NSScreenSaverWindowLevel;
    [panel orderFrontRegardless];
    return (panel.visible ? 1u : 0u) | (panel.onActiveSpace ? 2u : 0u);
}

void axonkey_hide_quick_overlay_window(void *window_ptr) {
    NSCAssert(NSThread.isMainThread, @"Quick overlay dismissal requires AppKit's main thread");
    if (quickOverlayPanel) {
        [quickOverlayPanel orderOut:nil];
    }
    if (window_ptr) {
        NSWindow *window = (__bridge NSWindow *)window_ptr;
        [window orderOut:nil];
    }
}
