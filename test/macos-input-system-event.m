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

static int CheckModifierEvent(uint16_t code, CGEventFlags down_flags, bool down) {
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
        fputs("failed to post modifier event\n", stderr);
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
            "unexpected modifier event: tap=%u type=%u code=%lld flags=0x%llx\n",
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

static bool MappingHasDestination(CFArrayRef mappings, uint64_t source, uint64_t destination) {
    if (mappings == NULL) {
        return false;
    }
    for (CFIndex index = 0; index < CFArrayGetCount(mappings); index += 1) {
        CFTypeRef value = CFArrayGetValueAtIndex(mappings, index);
        uint64_t actual_source = 0;
        if (!axonkey_mapping_get_source(value, &actual_source) || actual_source != source) {
            continue;
        }
        CFTypeRef destination_value = CFDictionaryGetValue(
            (CFDictionaryRef)value,
            CFSTR("HIDKeyboardModifierMappingDst")
        );
        uint64_t actual_destination = 0;
        return axonkey_cf_number_get_u64(destination_value, &actual_destination) &&
            actual_destination == destination;
    }
    return false;
}

static int CheckModifierMappingReplacementAndRestore(void) {
    const uint64_t voice = 0x000000070000003E;
    const uint64_t menu = 0x0000000700000065;
    const uint64_t television = 0x0000000700000035;
    const uint64_t function = 0x000000FF00000003;
    const uint64_t right_control = 0x00000007000000E4;
    const uint64_t right_option = 0x00000007000000E6;
    const uint64_t space = 0x000000070000002C;
    const AxonkeyHardwareModifierMapping requested[] = {
        {.source = voice, .destination = function},
        {.source = menu, .destination = right_control},
    };
    AxonkeyInputState state = {
        .modifier_mappings = requested,
        .modifier_mapping_count = sizeof(requested) / sizeof(requested[0]),
    };
    CFMutableArrayRef current = CFArrayCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeArrayCallBacks
    );
    CFDictionaryRef old_voice = axonkey_create_usage_mapping(voice, right_option);
    CFDictionaryRef old_menu = axonkey_create_usage_mapping(menu, space);
    CFDictionaryRef unrelated = axonkey_create_usage_mapping(television, space);
    if (current == NULL || old_voice == NULL || old_menu == NULL || unrelated == NULL) {
        if (current != NULL) CFRelease(current);
        if (old_voice != NULL) CFRelease(old_voice);
        if (old_menu != NULL) CFRelease(old_menu);
        if (unrelated != NULL) CFRelease(unrelated);
        fputs("failed to create modifier mapping fixtures\n", stderr);
        return 1;
    }
    CFArrayAppendValue(current, old_voice);
    CFArrayAppendValue(current, old_menu);
    CFArrayAppendValue(current, unrelated);
    CFRelease(old_voice);
    CFRelease(old_menu);
    CFRelease(unrelated);

    CFMutableArrayRef originals = axonkey_copy_original_modifier_mappings(&state, current);
    CFMutableArrayRef replacements = axonkey_create_modifier_mappings(&state);
    CFMutableArrayRef desired = axonkey_copy_replacing_modifier_mappings(
        &state,
        current,
        replacements
    );
    CFMutableArrayRef restored = axonkey_copy_replacing_modifier_mappings(
        &state,
        desired,
        originals
    );
    bool valid = originals != NULL && CFArrayGetCount(originals) == 2 &&
        desired != NULL && CFArrayGetCount(desired) == 3 &&
        MappingHasDestination(desired, voice, function) &&
        MappingHasDestination(desired, menu, right_control) &&
        MappingHasDestination(desired, television, space) &&
        restored != NULL && CFArrayGetCount(restored) == 3 &&
        MappingHasDestination(restored, voice, right_option) &&
        MappingHasDestination(restored, menu, space) &&
        MappingHasDestination(restored, television, space);
    CFRelease(current);
    if (originals != NULL) CFRelease(originals);
    if (replacements != NULL) CFRelease(replacements);
    if (desired != NULL) CFRelease(desired);
    if (restored != NULL) CFRelease(restored);
    if (!valid) {
        fputs("modifier mappings were not replaced and restored correctly\n", stderr);
        return 1;
    }
    return 0;
}

static int CheckHardwareMappedFnPassThrough(void) {
    const AxonkeyHardwareModifierMapping requested[] = {
        {
            .source = 0x000000070000003E,
            .destination = 0x000000FF00000003,
        },
    };
    AxonkeyInputState state = {
        .event_tap = (CFMachPortRef)1,
        .modifier_mappings = requested,
        .modifier_mapping_count = 1,
    };
    const uint8_t pressed_report[] = {0x3e, 0x00};
    axonkey_arm_report_events(&state, 1, pressed_report, sizeof(pressed_report));

    CGEventRef function_event = CGEventCreateKeyboardEvent(NULL, 63, true);
    CGEventSetFlags(function_event, kCGEventFlagMaskSecondaryFn);
    CGEventRef filtered_function = axonkey_event_tap_callback(
        NULL,
        kCGEventFlagsChanged,
        function_event,
        &state
    );
    CFRelease(function_event);
    if (filtered_function == NULL) {
        fputs("hardware-mapped Fn event was filtered\n", stderr);
        return 1;
    }

    CGEventRef original_event = CGEventCreateKeyboardEvent(NULL, 96, true);
    CGEventRef filtered_original = axonkey_event_tap_callback(
        NULL,
        kCGEventKeyDown,
        original_event,
        &state
    );
    CFRelease(original_event);
    if (filtered_original != NULL) {
        fputs("original event for hardware-mapped Fn source was not filtered\n", stderr);
        return 1;
    }
    return 0;
}

static int CheckTelevisionPassThroughFiltered(void) {
    AxonkeyInputState state = {
        .event_tap = (CFMachPortRef)1,
    };
    const uint8_t pressed_report[] = {0x35, 0x00};
    axonkey_arm_report_events(&state, 1, pressed_report, sizeof(pressed_report));

    CGEventRef down_event = CGEventCreateKeyboardEvent(NULL, 50, true);
    CGEventRef filtered_down = axonkey_event_tap_callback(
        NULL,
        kCGEventKeyDown,
        down_event,
        &state
    );
    CFRelease(down_event);
    if (filtered_down != NULL) {
        fputs("television key-down pass-through was not filtered\n", stderr);
        return 1;
    }

    const uint8_t released_report[] = {0x00, 0x00};
    axonkey_arm_report_events(&state, 1, released_report, sizeof(released_report));
    CGEventRef up_event = CGEventCreateKeyboardEvent(NULL, 50, false);
    CGEventRef filtered_up = axonkey_event_tap_callback(
        NULL,
        kCGEventKeyUp,
        up_event,
        &state
    );
    CFRelease(up_event);
    if (filtered_up != NULL) {
        fputs("television key-up pass-through was not filtered\n", stderr);
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
            CheckModifierEvent(
                59,
                kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK,
                true
            ) ||
            CheckControlRightArrowEvent(true) ||
            CheckControlRightArrowEvent(false) ||
            CheckModifierMappingReplacementAndRestore() ||
            CheckHardwareMappedFnPassThrough() ||
            CheckTelevisionPassThroughFiltered() ||
            CheckModifierEvent(
                59,
                kCGEventFlagMaskControl | NX_DEVICELCTLKEYMASK,
                false
            ) ||
            CheckModifierEvent(62, kCGEventFlagMaskControl | 0x00002000, true) ||
            CheckModifierEvent(62, kCGEventFlagMaskControl | 0x00002000, false) ||
            CheckModifierEvent(63, kCGEventFlagMaskSecondaryFn, true) ||
            CheckModifierEvent(63, kCGEventFlagMaskSecondaryFn, false);
        method_setImplementation(method, original);
        if (captured_posted_event != NULL) {
            CFRelease(captured_posted_event);
        }
        return result;
    }
}
