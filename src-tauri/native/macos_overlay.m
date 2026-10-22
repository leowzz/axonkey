#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

@interface AxonkeyProfileSwitchPanel : NSPanel
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
    panel.fromLabel = profileSwitchLabel(@"", 17, NSFontWeightRegular, 0.75);
    panel.arrowLabel = profileSwitchLabel(@"→", 17, NSFontWeightRegular, 1);
    panel.toLabel = profileSwitchLabel(@"", 17, NSFontWeightSemibold, 1);
    [root addSubview:panel.fromLabel];
    [root addSubview:panel.arrowLabel];
    [root addSubview:panel.toLabel];
    panel.contentView = root;
    return panel;
}

// AppKit main thread only. Rendering and expiry do not depend on a hidden
// WebView running JavaScript in another desktop.
unsigned int axonkey_show_profile_switch_overlay(const char *from, const char *to) {
    NSCAssert(NSThread.isMainThread, @"Profile notifications require AppKit's main thread");
    if (!profileSwitchPanel) profileSwitchPanel = createProfileSwitchPanel();
    AxonkeyProfileSwitchPanel *panel = profileSwitchPanel;
    [panel orderOut:nil];
    panel.fromLabel.stringValue = [NSString stringWithUTF8String:from] ?: @"";
    panel.toLabel.stringValue = [NSString stringWithUTF8String:to] ?: @"";
    CGFloat fromWidth = MIN(142, panel.fromLabel.fittingSize.width);
    panel.fromLabel.frame = NSMakeRect(64, 24, fromWidth, 26);
    panel.arrowLabel.frame = NSMakeRect(64 + fromWidth + 12, 24, 18, 26);
    panel.toLabel.frame = NSMakeRect(64 + fromWidth + 42, 24, 332 - fromWidth - 42, 26);

    NSPoint mouse = NSEvent.mouseLocation;
    NSScreen *screen = NSScreen.screens.firstObject;
    for (NSScreen *candidate in NSScreen.screens) {
        if (NSPointInRect(mouse, candidate.frame)) { screen = candidate; break; }
    }
    NSRect area = screen.visibleFrame;
    [panel setFrame:NSMakeRect(NSMidX(area) - 210, NSMinY(area) + NSHeight(area) * 0.25 - 50, 420, 100) display:YES];
    [panel orderFrontRegardless];

    uint64_t revision = ++profileSwitchRevision;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (revision == profileSwitchRevision) [profileSwitchPanel orderOut:nil];
    });
    return (panel.visible ? 1u : 0u) | (panel.onActiveSpace ? 2u : 0u);
}
