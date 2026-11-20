#import "../src-tauri/native/macos_overlay.m"
#include <assert.h>
#include <stdio.h>

static int escapeCount = 0;

static bool onQuickEscape(void) {
    escapeCount += 1;
    return true;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        BOOL wasActive = NSApp.active;

        NSWindow *sourceWindow = [[NSWindow alloc]
            initWithContentRect:NSMakeRect(0, 0, 880, 660)
            styleMask:NSWindowStyleMaskBorderless
            backing:NSBackingStoreBuffered
            defer:NO];
        NSView *hostContent = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 880, 660)];
        NSView *childWebView = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 880, 660)];
        [hostContent addSubview:childWebView];
        sourceWindow.contentView = hostContent;

        axonkey_configure_quick_overlay_window((__bridge void *)sourceWindow, onQuickEscape);
        assert(quickOverlayPanel != nil);
        assert([quickOverlayPanel isKindOfClass:NSPanel.class]);
        assert(quickOverlayPanel.contentView == hostContent);
        assert(sourceWindow.contentView != hostContent);
        assert(sourceWindow.ignoresMouseEvents);

        unsigned int status = axonkey_show_quick_overlay_window((__bridge void *)sourceWindow, 880.0, 660.0, true);
        assert((status & 1u) != 0); // visible
        assert((status & 2u) != 0); // active_space
        assert(NSApp.active == wasActive);
        assert(quickOverlayPanel.styleMask & NSWindowStyleMaskNonactivatingPanel);
        assert(quickOverlayPanel.collectionBehavior & NSWindowCollectionBehaviorMoveToActiveSpace);
        assert(!(quickOverlayPanel.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces));
        assert(quickOverlayPanel.collectionBehavior & NSWindowCollectionBehaviorFullScreenAuxiliary);
        assert(quickOverlayPanel.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllApplications);
        assert(!quickOverlayPanel.canBecomeKeyWindow);
        assert(!quickOverlayPanel.canBecomeMainWindow);
        assert(quickOverlayPanel.level == NSScreenSaverWindowLevel);
        assert(NSEqualSizes(hostContent.frame.size, quickOverlayPanel.frame.size));
        assert(NSEqualSizes(childWebView.frame.size, hostContent.bounds.size));

        // Non-forced reveal keeps the same panel without flickering or losing active Space.
        AxonkeyQuickOverlayPanel *firstPanel = quickOverlayPanel;
        unsigned int revealStatus = axonkey_show_quick_overlay_window((__bridge void *)sourceWindow, 880.0, 660.0, false);
        assert((revealStatus & 3u) == 3u);
        assert(quickOverlayPanel == firstPanel);

        // Hide and re-show reuses the panel cleanly and lands on the active Space.
        axonkey_hide_quick_overlay_window((__bridge void *)sourceWindow);
        assert(!quickOverlayPanel.visible);
        assert(!sourceWindow.visible);

        unsigned int reopenStatus = axonkey_show_quick_overlay_window((__bridge void *)sourceWindow, 880.0, 660.0, true);
        assert((reopenStatus & 3u) == 3u);
        assert(quickOverlayPanel == firstPanel);
        assert(NSApp.active == wasActive);

        axonkey_hide_quick_overlay_window((__bridge void *)sourceWindow);
        assert(escapeCount == 0);
        puts("quick overlay native panel: visible=1 active_space=1 nonactivating=1 fullscreen_aux=1 reuse=1");
    }
    return 0;
}
