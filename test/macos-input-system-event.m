#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/runtime.h>
#import <pthread.h>

static CGEventRef captured_posted_event = NULL;
static CGEventRef previous_posted_event = NULL;
static int posted_event_count = 0;
static CGEventTapLocation captured_posted_tap = kCGAnnotatedSessionEventTap;
static void CaptureEventPost(CGEventTapLocation tap, CGEventRef event);

#define CGEventPost CaptureEventPost
#import "../src-tauri/native/macos_input.m"
#undef CGEventPost

static void CaptureEventPost(CGEventTapLocation tap, CGEventRef event) {
    posted_event_count++;
    if (previous_posted_event != NULL) CFRelease(previous_posted_event);
    previous_posted_event = captured_posted_event == NULL ? NULL : CGEventCreateCopy(captured_posted_event);
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
    if (!axonkey_macos_post_key(code, down, flags, false, true) || captured_posted_event == NULL) {
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
    if (!axonkey_macos_post_key(124, down, flags, false, false) || captured_posted_event == NULL) {
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

static int CheckPointerEvents(void) {
    const int axes[][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
    for (int i = 0; i < 4; i++) {
        int before = posted_event_count;
        if (!axonkey_macos_post_wheel(axes[i][0], axes[i][1]) ||
            posted_event_count != before + 1 ||
            captured_posted_tap != kCGHIDEventTap ||
            CGEventGetType(captured_posted_event) != kCGEventScrollWheel ||
            CGEventGetIntegerValueField(captured_posted_event, kCGScrollWheelEventDeltaAxis1) != axes[i][0] ||
            CGEventGetIntegerValueField(captured_posted_event, kCGScrollWheelEventDeltaAxis2) != axes[i][1] ||
            CGEventGetIntegerValueField(captured_posted_event, kCGScrollWheelEventIsContinuous) != 0 ||
            CGEventGetIntegerValueField(captured_posted_event, kCGEventSourceUserData) != AXONKEY_SYNTHETIC_EVENT_MARKER) {
            fputs("incorrect wheel event\n", stderr);
            return 1;
        }
    }
    const int buttons[] = {0, 1, 3};
    const CGEventType downs[] = {kCGEventLeftMouseDown, kCGEventRightMouseDown, kCGEventOtherMouseDown};
    const CGEventType ups[] = {kCGEventLeftMouseUp, kCGEventRightMouseUp, kCGEventOtherMouseUp};
    for (int i = 0; i < 3; i++) {
        int button = buttons[i];
        int before = posted_event_count;
        if (!axonkey_macos_post_mouse_click(button) || posted_event_count != before + 2 ||
            CGEventGetType(previous_posted_event) != downs[i] ||
            CGEventGetType(captured_posted_event) != ups[i] ||
            !CGPointEqualToPoint(CGEventGetLocation(previous_posted_event), CGEventGetLocation(captured_posted_event))) {
            fputs("incorrect mouse down/up pair\n", stderr);
            return 1;
        }
        CGEventRef events[] = {previous_posted_event, captured_posted_event};
        for (int field = 0; field < 2; field++) {
            if (CGEventGetIntegerValueField(events[field], kCGMouseEventButtonNumber) != button ||
                CGEventGetIntegerValueField(events[field], kCGMouseEventClickState) != 1 ||
                CGEventGetIntegerValueField(events[field], kCGEventSourceUserData) != AXONKEY_SYNTHETIC_EVENT_MARKER) {
                fputs("incorrect mouse event fields\n", stderr);
                return 1;
            }
        }
    }
    int before = posted_event_count;
    if (axonkey_macos_post_mouse_click(2) || posted_event_count != before) return 1;
    const int moves[][2] = {{0, -20}, {0, 20}, {-20, 0}, {20, 0}};
    for (int i = 0; i < 4; i++) {
        CGEventRef probe = CGEventCreate(NULL);
        CGPoint origin = probe == NULL ? CGPointZero : CGEventGetLocation(probe);
        if (probe != NULL) CFRelease(probe);
        before = posted_event_count;
        if (!axonkey_macos_post_mouse_move(moves[i][0], moves[i][1]) ||
            posted_event_count != before + 1 ||
            captured_posted_tap != kCGHIDEventTap ||
            CGEventGetType(captured_posted_event) != kCGEventMouseMoved ||
            CGEventGetIntegerValueField(captured_posted_event, kCGEventSourceUserData) != AXONKEY_SYNTHETIC_EVENT_MARKER) {
            fputs("incorrect mouse move event\n", stderr);
            return 1;
        }
        CGPoint moved = CGEventGetLocation(captured_posted_event);
        if (moved.x != origin.x + moves[i][0] || moved.y != origin.y + moves[i][1]) {
            fprintf(stderr, "mouse move location actual=(%f,%f) expected=(%f,%f)\n",
                    moved.x, moved.y, origin.x + moves[i][0], origin.y + moves[i][1]);
            return 1;
        }
    }
    return 0;
}

static int CheckMouseScrollAmounts(void) {
    CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, 0, 0);
    CGEventField lines[] = {kCGScrollWheelEventDeltaAxis1, kCGScrollWheelEventDeltaAxis2};
    CGEventField fixed[] = {kCGScrollWheelEventFixedPtDeltaAxis1, kCGScrollWheelEventFixedPtDeltaAxis2};
    CGEventField points[] = {kCGScrollWheelEventPointDeltaAxis1, kCGScrollWheelEventPointDeltaAxis2};
    for (int axis = 0; axis < 2; axis++) {
        for (int sign = -1; sign <= 1; sign += 2) {
            CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, 0);
            CGEventSetIntegerValueField(event, lines[axis], sign);
            CGEventSetDoubleValueField(event, fixed[axis], sign * 0.25);
            if (axonkey_mouse_scroll_amount(event, lines[axis], fixed[axis], points[axis]) != sign) {
                fprintf(stderr, "First discrete tick must trigger despite fractional line delta\n");
                CFRelease(event);
                return 1;
            }
            CGEventSetIntegerValueField(event, lines[axis], 0);
            CGEventSetDoubleValueField(event, fixed[axis], sign * 0.25);
            if (axonkey_mouse_scroll_amount(event, lines[axis], fixed[axis], points[axis]) != sign * 0.25) {
                fprintf(stderr, "fraction actual=%f fixed=%f line=%lld\n", axonkey_mouse_scroll_amount(event, lines[axis], fixed[axis], points[axis]), CGEventGetDoubleValueField(event, fixed[axis]), (long long)CGEventGetIntegerValueField(event, lines[axis]));
                CFRelease(event);
                return 1;
            }
            CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, 1);
            CGEventSetIntegerValueField(event, points[axis], sign * 2);
            if (axonkey_mouse_scroll_amount(event, lines[axis], fixed[axis], points[axis]) != sign * 0.2) {
                fprintf(stderr, "Continuous scroll must retain fractional accumulation\n");
                CFRelease(event);
                return 1;
            }
        }
    }
    CFRelease(event);
    return 0;
}

int main(void) {
    if (CheckMouseScrollAmounts()) return 1;
    @autoreleasepool {
        Method method = class_getClassMethod([NSEvent class], @selector(eventWithCGEvent:));
        IMP original = method_setImplementation(method, (IMP)RejectEventWithCGEvent);
        int result = CheckPointerEvents() || CheckSystemEvent(NX_KEYTYPE_SOUND_UP, NX_KEYDOWN) ||
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
        if (previous_posted_event != NULL) CFRelease(previous_posted_event);
        return result;
    }
}
