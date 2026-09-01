#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#import <pthread.h>

static CGEventRef captured_posted_event = NULL;
static CGEventTapLocation captured_posted_tap = kCGAnnotatedSessionEventTap;
static void CaptureEventPost(CGEventTapLocation tap, CGEventRef event);

#define CGEventPost CaptureEventPost
#import "../src-tauri/native/macos_input.m"
#undef CGEventPost

static void CaptureEventPost(CGEventTapLocation tap, CGEventRef event) {
    captured_posted_tap = tap;
    if (captured_posted_event != NULL) {
        CFRelease(captured_posted_event);
    }
    captured_posted_event = CGEventCreateCopy(event);
}

typedef struct {
    CGEventRef event;
    bool described;
    int kind;
    int code;
    bool down;
} DescribeEventContext;

static id RejectEventWithCGEvent(id self, SEL command, CGEventRef event) {
    (void)self;
    (void)command;
    (void)event;
    return nil;
}

static void *DescribeEvent(void *raw_context) {
    DescribeEventContext *context = raw_context;
    context->described = axonkey_describe_cg_event(
        (CGEventType)NX_SYSDEFINED,
        context->event,
        &context->kind,
        &context->code,
        &context->down
    );
    return NULL;
}

static CGEventRef CreateSystemEvent(int code, int edge) {
    int data1 = (code << 16) | (edge << 8);
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeSystemDefined
                                        location:NSZeroPoint
                                   modifierFlags:0
                                       timestamp:[NSProcessInfo processInfo].systemUptime
                                    windowNumber:0
                                         context:nil
                                         subtype:NX_SUBTYPE_AUX_CONTROL_BUTTONS
                                           data1:data1
                                           data2:-1];
    return CGEventCreateCopy(event.CGEvent);
}

static int CheckSystemEvent(int expected_code, int edge) {
    DescribeEventContext context = {
        .event = CreateSystemEvent(expected_code, edge),
    };
    if (context.event == NULL) {
        fputs("failed to create system event\n", stderr);
        return 1;
    }

    pthread_t thread;
    int create_result = pthread_create(&thread, NULL, DescribeEvent, &context);
    int join_result = create_result == 0 ? pthread_join(thread, NULL) : create_result;
    CFRelease(context.event);
    if (create_result != 0 || join_result != 0) {
        fputs("failed to run event parser thread\n", stderr);
        return 1;
    }
    bool expected_down = edge == NX_KEYDOWN;
    if (!context.described || context.kind != AXONKEY_NATIVE_EVENT_SYSTEM ||
        context.code != expected_code || context.down != expected_down) {
        fprintf(
            stderr,
            "unexpected system event: described=%d kind=%d code=%d down=%d\n",
            context.described,
            context.kind,
            context.code,
            context.down
        );
        return 1;
    }
    return 0;
}

static int CheckControlEvent(uint16_t code, CGEventFlags down_flags, bool down) {
    const CGEventFlags flags = down ? down_flags : 0;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGEventRef reference = CGEventCreateKeyboardEvent(source, code, down);
    CFRelease(source);
    CGEventFlags expected_flags = (
        CGEventGetFlags(reference)
        & (kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn)
    ) | flags;
    CFRelease(reference);
    if (!axonkey_macos_post_key(code, down, flags, false) || captured_posted_event == NULL) {
        fputs("failed to post Control event\n", stderr);
        return 1;
    }
    CGEventType type = CGEventGetType(captured_posted_event);
    int64_t actual_code = CGEventGetIntegerValueField(
        captured_posted_event,
        kCGKeyboardEventKeycode
    );
    CGEventFlags actual_flags = CGEventGetFlags(captured_posted_event);
    if (captured_posted_tap != kCGSessionEventTap ||
        type != kCGEventFlagsChanged || actual_code != code ||
        actual_flags != expected_flags) {
        fprintf(
            stderr,
            "unexpected Control event: tap=%u type=%u code=%lld flags=0x%llx\n",
            (unsigned int)captured_posted_tap,
            (unsigned int)type,
            (long long)actual_code,
            (unsigned long long)actual_flags
        );
        return 1;
    }
    return 0;
}

static int CheckControlRightArrowEvent(bool down) {
    const CGEventFlags flags = kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK;
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGEventRef reference = CGEventCreateKeyboardEvent(source, 124, down);
    CFRelease(source);
    CGEventFlags expected_flags = (
        CGEventGetFlags(reference)
        & (kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn)
    ) | flags;
    CFRelease(reference);
    if (!axonkey_macos_post_key(124, down, flags, false) || captured_posted_event == NULL) {
        fputs("failed to post Control-Right Arrow event\n", stderr);
        return 1;
    }
    CGEventType expected_type = down ? kCGEventKeyDown : kCGEventKeyUp;
    CGEventType type = CGEventGetType(captured_posted_event);
    int64_t code = CGEventGetIntegerValueField(
        captured_posted_event,
        kCGKeyboardEventKeycode
    );
    CGEventFlags actual_flags = CGEventGetFlags(captured_posted_event);
    if (captured_posted_tap != kCGSessionEventTap || type != expected_type ||
        code != 124 || actual_flags != expected_flags) {
        fprintf(
            stderr,
            "unexpected Control-Right Arrow event: tap=%u type=%u code=%lld flags=0x%llx\n",
            (unsigned int)captured_posted_tap,
            (unsigned int)type,
            (long long)code,
            (unsigned long long)actual_flags
        );
        return 1;
    }
    return 0;
}

int main(void) {
    @autoreleasepool {
        Method method = class_getClassMethod([NSEvent class], @selector(eventWithCGEvent:));
        IMP original = method_setImplementation(method, (IMP)RejectEventWithCGEvent);
        int result = CheckSystemEvent(NX_KEYTYPE_SOUND_UP, NX_KEYDOWN) ||
            CheckSystemEvent(NX_KEYTYPE_SOUND_DOWN, NX_KEYUP) ||
            CheckControlEvent(
                59,
                kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK,
                true
            ) ||
            CheckControlRightArrowEvent(true) ||
            CheckControlRightArrowEvent(false) ||
            CheckControlEvent(
                59,
                kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK,
                false
            ) ||
            CheckControlEvent(62, kCGEventFlagMaskControl | 0x00002000, true) ||
            CheckControlEvent(62, kCGEventFlagMaskControl | 0x00002000, false);
        method_setImplementation(method, original);
        if (captured_posted_event != NULL) {
            CFRelease(captured_posted_event);
        }
        return result;
    }
}
