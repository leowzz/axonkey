#import <AppKit/AppKit.h>
#include <stdbool.h>

@interface AxonkeyFileDragSource : NSObject <NSDraggingSource>
@end

@implementation AxonkeyFileDragSource
- (NSDragOperation)draggingSession:(NSDraggingSession *)session
  sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    (void)session;
    return context == NSDraggingContextOutsideApplication
        ? (NSDragOperationCopy | NSDragOperationLink | NSDragOperationGeneric)
        : NSDragOperationNone;
}
@end

static AxonkeyFileDragSource *axonkey_shared_drag_source(void) {
    static AxonkeyFileDragSource *source = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        source = [[AxonkeyFileDragSource alloc] init];
    });
    return source;
}

bool axonkey_macos_start_file_drag(void *ns_window_ptr, const char *path_utf8) {
    if (ns_window_ptr == NULL || path_utf8 == NULL) {
        return false;
    }
    if (([NSEvent pressedMouseButtons] & 1) == 0) {
        return false;
    }
    @try {
        NSWindow *window = (__bridge NSWindow *)ns_window_ptr;
        NSView *view = [window.firstResponder isKindOfClass:[NSView class]]
            ? (NSView *)window.firstResponder
            : window.contentView;
        if (view == nil) {
            return false;
        }
        NSString *path = [NSString stringWithUTF8String:path_utf8];
        if (path.length == 0 || ![[NSFileManager defaultManager] fileExistsAtPath:path]) {
            return false;
        }
        NSURL *fileURL = [NSURL fileURLWithPath:path];
        if (fileURL == nil) {
            return false;
        }

        NSPoint screenLocation = [NSEvent mouseLocation];
        NSPoint windowLocation = [window convertPointFromScreen:screenLocation];
        NSPoint viewLocation = [view convertPoint:windowLocation fromView:nil];

        NSEvent *current = [NSApp currentEvent];
        NSEvent *event = nil;
        if (current != nil && current.window == window &&
            (current.type == NSEventTypeLeftMouseDown || current.type == NSEventTypeLeftMouseDragged)) {
            event = current;
        } else {
            NSInteger eventNumber = (current != nil && current.window == window) ? current.eventNumber : 0;
            event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                                       location:windowLocation
                                  modifierFlags:[NSEvent modifierFlags]
                                      timestamp:[[NSProcessInfo processInfo] systemUptime]
                                   windowNumber:window.windowNumber
                                        context:nil
                                    eventNumber:eventNumber
                                     clickCount:1
                                       pressure:1.0f];
        }
        if (event == nil) {
            return false;
        }

        NSImage *icon = [[[NSWorkspace sharedWorkspace] iconForFile:path] copy];
        NSSize iconSize = NSMakeSize(56.0, 56.0);
        [icon setSize:iconSize];

        NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:fileURL];
        NSRect dragFrame = NSMakeRect(
            viewLocation.x - iconSize.width * 0.5,
            viewLocation.y - iconSize.height * 0.5,
            iconSize.width,
            iconSize.height
        );
        [item setDraggingFrame:dragFrame contents:icon];

        NSDraggingSession *session = [view beginDraggingSessionWithItems:@[item]
                                                                   event:event
                                                                  source:axonkey_shared_drag_source()];
        session.animatesToStartingPositionsOnCancelOrFail = YES;
        return session != nil;
    } @catch (NSException *exception) {
        (void)exception;
        return false;
    }
}
