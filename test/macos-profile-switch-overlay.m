#import "../src-tauri/native/macos_overlay.m"
#include <assert.h>
#include <stdio.h>

static void runFor(NSTimeInterval duration) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:duration]];
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        // Exercise the same regular-app policy as an open Axonkey main window.
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        BOOL wasActive = NSApp.active;
        unsigned int status = axonkey_show_profile_switch_overlay("工作", "游戏");
        assert(status == 3); // visible, on the currently active Space
        assert(NSApp.active == wasActive);
        assert([profileSwitchPanel isKindOfClass:NSPanel.class]);
        assert(profileSwitchPanel.styleMask & NSWindowStyleMaskNonactivatingPanel);
        assert(profileSwitchPanel.collectionBehavior & NSWindowCollectionBehaviorMoveToActiveSpace);
        assert(!(profileSwitchPanel.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces));
        assert(profileSwitchPanel.collectionBehavior & NSWindowCollectionBehaviorFullScreenAuxiliary);
        assert(profileSwitchPanel.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllApplications);
        assert(!profileSwitchPanel.canBecomeKeyWindow);
        assert(!profileSwitchPanel.canBecomeMainWindow);
        assert(!profileSwitchPanel.keyWindow);
        assert(profileSwitchPanel.ignoresMouseEvents);
        assert(profileSwitchPanel.level == NSStatusWindowLevel);
        assert([profileSwitchPanel.fromLabel.stringValue isEqualToString:@"工作"]);
        assert([profileSwitchPanel.toLabel.stringValue isEqualToString:@"游戏"]);
        NSVisualEffectView *blur = (NSVisualEffectView *)profileSwitchPanel.contentView.subviews.firstObject;
        assert([blur isKindOfClass:NSVisualEffectView.class]);
        assert(blur.blendingMode == NSVisualEffectBlendingModeBehindWindow);
        assert(blur.state == NSVisualEffectStateActive);
        NSRect area = profileSwitchPanel.screen.visibleFrame;
        assert(NSContainsRect(area, profileSwitchPanel.frame));
        assert(NSMidY(profileSwitchPanel.frame) < NSMidY(area));

        AxonkeyProfileSwitchPanel *firstPanel = profileSwitchPanel;
        runFor(1.1);
        status = axonkey_show_profile_switch_overlay("游戏", "阅读");
        assert(status == 3);
        assert(profileSwitchPanel == firstPanel);
        runFor(1.1); // The original notification's expiry must not hide this one.
        assert(profileSwitchPanel.visible);
        assert([profileSwitchPanel.toLabel.stringValue isEqualToString:@"阅读"]);
        assert(NSApp.active == wasActive);
        runFor(1.2);
        assert(!profileSwitchPanel.visible);
        // Reuse after hiding must also join the active Space.
        status = axonkey_show_profile_switch_overlay("阅读", "工作");
        assert(status == 3);
        assert(NSApp.active == wasActive);
        [profileSwitchPanel orderOut:nil];
        puts("native panel: active_space=1 nonactivating=1 lower_half=1 blur=1 rapid_switch_expiry=1 reuse=1");
    }
    return 0;
}
