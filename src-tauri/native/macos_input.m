#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreFoundation/CoreFoundation.h>
#import <IOKit/hid/IOHIDManager.h>
#import <IOKit/hidsystem/IOHIDLib.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#import <IOKit/hidsystem/ev_keymap.h>

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum {
    AXONKEY_EVENT_BACKEND_READY = 1,
    AXONKEY_EVENT_DEVICE_CONNECTED = 2,
    AXONKEY_EVENT_DEVICE_DISCONNECTED = 3,
    AXONKEY_EVENT_INPUT_REPORT = 4,
    AXONKEY_EVENT_BACKEND_ERROR = 5,
    AXONKEY_EVENT_TICK = 6,
};

enum {
    AXONKEY_CAPTURE_NONE = 0,
    AXONKEY_CAPTURE_SEIZED = 1,
    AXONKEY_CAPTURE_FILTERED = 2,
    AXONKEY_NATIVE_EVENT_KEYBOARD = 1,
    AXONKEY_NATIVE_EVENT_SYSTEM = 2,
    AXONKEY_MAX_PENDING_EVENTS = 32,
    AXONKEY_MAX_HELD_EVENTS = 16,
    AXONKEY_MAX_ACTIVE_USAGES = 32,
};

static const int64_t AXONKEY_SYNTHETIC_EVENT_MARKER = 0x41584F4E4B4559;

typedef bool (*AxonkeyStopCallback)(void *context);
typedef void (*AxonkeyEventCallback)(
    void *context,
    int event,
    uint32_t report_id,
    const uint8_t *bytes,
    size_t length,
    int code
);

typedef struct {
    void *context;
    AxonkeyStopCallback should_stop;
    AxonkeyEventCallback on_event;
} AxonkeyCallbacks;

typedef struct {
    int kind;
    int code;
    bool down;
    CFAbsoluteTime expires_at;
} AxonkeyPendingEvent;

typedef struct {
    int kind;
    int code;
    size_t count;
} AxonkeyHeldEvent;

typedef struct {
    const AxonkeyCallbacks *callbacks;
    bool capture;
    CFMutableSetRef devices;
    CFMutableSetRef seized_devices;
    CFMutableSetRef monitored_devices;
    CFMachPortRef event_tap;
    CFRunLoopSourceRef event_tap_source;
    AxonkeyPendingEvent pending_events[AXONKEY_MAX_PENDING_EVENTS];
    size_t pending_event_count;
    AxonkeyHeldEvent held_events[AXONKEY_MAX_HELD_EVENTS];
    size_t held_event_count;
    uint16_t active_usages[AXONKEY_MAX_ACTIVE_USAGES];
    size_t active_usage_count;
} AxonkeyInputState;

static bool axonkey_native_event_equal(int lhs_kind, int lhs_code, int rhs_kind, int rhs_code) {
    return lhs_kind == rhs_kind && lhs_code == rhs_code;
}

static void axonkey_remove_pending_event(AxonkeyInputState *state, size_t index) {
    if (state == NULL || index >= state->pending_event_count) {
        return;
    }
    size_t remaining = state->pending_event_count - index - 1;
    if (remaining > 0) {
        memmove(
            &state->pending_events[index],
            &state->pending_events[index + 1],
            remaining * sizeof(AxonkeyPendingEvent)
        );
    }
    state->pending_event_count -= 1;
}

static void axonkey_expire_pending_events(AxonkeyInputState *state, CFAbsoluteTime now) {
    if (state == NULL) {
        return;
    }
    for (size_t index = state->pending_event_count; index > 0; index -= 1) {
        if (state->pending_events[index - 1].expires_at <= now) {
            axonkey_remove_pending_event(state, index - 1);
        }
    }
}

static size_t axonkey_held_event_index(AxonkeyInputState *state, int kind, int code) {
    if (state == NULL) {
        return SIZE_MAX;
    }
    for (size_t index = 0; index < state->held_event_count; index += 1) {
        AxonkeyHeldEvent held = state->held_events[index];
        if (axonkey_native_event_equal(held.kind, held.code, kind, code)) {
            return index;
        }
    }
    return SIZE_MAX;
}

static void axonkey_remove_held_event(AxonkeyInputState *state, size_t index) {
    if (state == NULL || index >= state->held_event_count) {
        return;
    }
    size_t remaining = state->held_event_count - index - 1;
    if (remaining > 0) {
        memmove(
            &state->held_events[index],
            &state->held_events[index + 1],
            remaining * sizeof(AxonkeyHeldEvent)
        );
    }
    state->held_event_count -= 1;
}

static void axonkey_append_pending_event(
    AxonkeyInputState *state,
    int kind,
    int code,
    bool down,
    CFAbsoluteTime now
) {
    if (state->pending_event_count == AXONKEY_MAX_PENDING_EVENTS) {
        axonkey_remove_pending_event(state, 0);
    }
    state->pending_events[state->pending_event_count++] = (AxonkeyPendingEvent) {
        .kind = kind,
        .code = code,
        .down = down,
        .expires_at = now + 0.18,
    };
}

static void axonkey_arm_native_event(AxonkeyInputState *state, int kind, int code, bool down) {
    if (state == NULL || state->event_tap == NULL) {
        return;
    }
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    axonkey_expire_pending_events(state, now);
    size_t held_index = axonkey_held_event_index(state, kind, code);
    if (down) {
        if (held_index != SIZE_MAX) {
            state->held_events[held_index].count += 1;
        } else if (state->held_event_count < AXONKEY_MAX_HELD_EVENTS) {
            state->held_events[state->held_event_count++] = (AxonkeyHeldEvent) {
                .kind = kind,
                .code = code,
                .count = 1,
            };
        }
    } else {
        for (size_t index = 0; index < state->pending_event_count; index += 1) {
            AxonkeyPendingEvent pending = state->pending_events[index];
            if (pending.down && axonkey_native_event_equal(pending.kind, pending.code, kind, code)) {
                axonkey_remove_pending_event(state, index);
                break;
            }
        }
        if (held_index != SIZE_MAX) {
            if (state->held_events[held_index].count > 1) {
                state->held_events[held_index].count -= 1;
            } else {
                axonkey_remove_held_event(state, held_index);
            }
        }
    }
    axonkey_append_pending_event(state, kind, code, down, now);
}

static bool axonkey_native_event_for_usage(uint16_t usage, int *kind, int *code) {
    if (kind == NULL || code == NULL) {
        return false;
    }
    *kind = AXONKEY_NATIVE_EVENT_KEYBOARD;
    switch (usage) {
        case 0x3e: *code = 96; return true;
        case 0x66: *code = 90; return true;
        case 0x4a: *code = 115; return true;
        case 0x35: *code = 10; return true;
        case 0x65: *code = 110; return true;
        case 0x28: *code = 36; return true;
        case 0x52: *code = 126; return true;
        case 0x51: *code = 125; return true;
        case 0x50: *code = 123; return true;
        case 0x4f: *code = 124; return true;
        case 0x80:
            *kind = AXONKEY_NATIVE_EVENT_SYSTEM;
            *code = 0;
            return true;
        case 0x81:
            *kind = AXONKEY_NATIVE_EVENT_SYSTEM;
            *code = 1;
            return true;
        default:
            return false;
    }
}

static bool axonkey_usage_contains(const uint16_t *usages, size_t count, uint16_t usage) {
    for (size_t index = 0; index < count; index += 1) {
        if (usages[index] == usage) {
            return true;
        }
    }
    return false;
}

static void axonkey_arm_report_events(
    AxonkeyInputState *state,
    uint32_t report_id,
    const uint8_t *report,
    size_t report_length
) {
    if (state == NULL || state->event_tap == NULL || report_id != 1 || report == NULL) {
        return;
    }
    if (report_length == 7 && report[0] == (uint8_t)report_id) {
        report += 1;
        report_length -= 1;
    }
    if (report_length == 0 || report_length % 2 != 0) {
        return;
    }
    uint16_t usages[AXONKEY_MAX_ACTIVE_USAGES] = {0};
    size_t usage_count = 0;
    for (size_t offset = 0; offset + 1 < report_length; offset += 2) {
        uint16_t usage = (uint16_t)report[offset] | ((uint16_t)report[offset + 1] << 8);
        if (usage != 0 && usage_count < AXONKEY_MAX_ACTIVE_USAGES &&
            !axonkey_usage_contains(usages, usage_count, usage)) {
            usages[usage_count++] = usage;
        }
    }
    for (size_t index = 0; index < usage_count; index += 1) {
        if (!axonkey_usage_contains(state->active_usages, state->active_usage_count, usages[index])) {
            int kind = 0;
            int code = 0;
            if (axonkey_native_event_for_usage(usages[index], &kind, &code)) {
                axonkey_arm_native_event(state, kind, code, true);
            }
        }
    }
    for (size_t index = 0; index < state->active_usage_count; index += 1) {
        if (!axonkey_usage_contains(usages, usage_count, state->active_usages[index])) {
            int kind = 0;
            int code = 0;
            if (axonkey_native_event_for_usage(state->active_usages[index], &kind, &code)) {
                axonkey_arm_native_event(state, kind, code, false);
            }
        }
    }
    memcpy(state->active_usages, usages, usage_count * sizeof(uint16_t));
    state->active_usage_count = usage_count;
}

static bool axonkey_describe_cg_event(
    CGEventType type,
    CGEventRef event,
    int *kind,
    int *code,
    bool *down
) {
    if (event == NULL || kind == NULL || code == NULL || down == NULL) {
        return false;
    }
    if (type == kCGEventKeyDown || type == kCGEventKeyUp) {
        *kind = AXONKEY_NATIVE_EVENT_KEYBOARD;
        *code = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
        *down = type == kCGEventKeyDown;
        return true;
    }
    if ((uint32_t)type != 14) {
        return false;
    }
    NSEvent *ns_event = [NSEvent eventWithCGEvent:event];
    if (ns_event == nil) {
        return false;
    }
    NSInteger data1 = ns_event.data1;
    NSInteger edge = (data1 & 0x0000FF00) >> 8;
    if (edge != NX_KEYDOWN && edge != NX_KEYUP) {
        return false;
    }
    *kind = AXONKEY_NATIVE_EVENT_SYSTEM;
    *code = (int)((data1 & 0xFFFF0000) >> 16);
    *down = edge == NX_KEYDOWN;
    return true;
}

static CGEventRef axonkey_event_tap_callback(
    CGEventTapProxy proxy,
    CGEventType type,
    CGEventRef event,
    void *context
) {
    (void)proxy;
    AxonkeyInputState *state = context;
    if (state == NULL) {
        return event;
    }
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (state->event_tap != NULL) {
            CGEventTapEnable(state->event_tap, true);
        }
        return event;
    }
    if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) ==
        AXONKEY_SYNTHETIC_EVENT_MARKER) {
        return event;
    }
    int kind = 0;
    int code = 0;
    bool down = false;
    if (!axonkey_describe_cg_event(type, event, &kind, &code, &down)) {
        return event;
    }

    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    axonkey_expire_pending_events(state, now);
    for (size_t index = 0; index < state->pending_event_count; index += 1) {
        AxonkeyPendingEvent pending = state->pending_events[index];
        if (pending.down == down &&
            axonkey_native_event_equal(pending.kind, pending.code, kind, code)) {
            axonkey_remove_pending_event(state, index);
            return NULL;
        }
    }
    size_t held_index = axonkey_held_event_index(state, kind, code);
    if (down && held_index != SIZE_MAX) {
        if (kind == AXONKEY_NATIVE_EVENT_KEYBOARD &&
            CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) == 0) {
            axonkey_remove_held_event(state, held_index);
            return event;
        }
        return NULL;
    }
    return event;
}

static bool axonkey_start_event_filter(AxonkeyInputState *state, CFRunLoopRef run_loop) {
    if (state == NULL || run_loop == NULL) {
        return false;
    }
    CGEventMask event_mask = CGEventMaskBit(kCGEventKeyDown) |
        CGEventMaskBit(kCGEventKeyUp) |
        CGEventMaskBit((CGEventType)14);
    state->event_tap = CGEventTapCreate(
        kCGSessionEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionDefault,
        event_mask,
        axonkey_event_tap_callback,
        state
    );
    if (state->event_tap == NULL) {
        return false;
    }
    state->event_tap_source = CFMachPortCreateRunLoopSource(
        kCFAllocatorDefault,
        state->event_tap,
        0
    );
    if (state->event_tap_source == NULL) {
        CFRelease(state->event_tap);
        state->event_tap = NULL;
        return false;
    }
    CFRunLoopAddSource(run_loop, state->event_tap_source, kCFRunLoopCommonModes);
    CGEventTapEnable(state->event_tap, true);
    return true;
}

static void axonkey_stop_event_filter(AxonkeyInputState *state, CFRunLoopRef run_loop) {
    if (state == NULL) {
        return;
    }
    if (state->event_tap_source != NULL && run_loop != NULL) {
        CFRunLoopRemoveSource(run_loop, state->event_tap_source, kCFRunLoopCommonModes);
    }
    if (state->event_tap != NULL) {
        CGEventTapEnable(state->event_tap, false);
    }
    if (state->event_tap_source != NULL) {
        CFRelease(state->event_tap_source);
        state->event_tap_source = NULL;
    }
    if (state->event_tap != NULL) {
        CFRelease(state->event_tap);
        state->event_tap = NULL;
    }
    state->pending_event_count = 0;
    state->held_event_count = 0;
    state->active_usage_count = 0;
}

static void axonkey_emit(
    AxonkeyInputState *state,
    int event,
    uint32_t report_id,
    const uint8_t *bytes,
    size_t length,
    int code
) {
    if (state == NULL || state->callbacks == NULL || state->callbacks->on_event == NULL) {
        return;
    }
    state->callbacks->on_event(
        state->callbacks->context,
        event,
        report_id,
        bytes,
        length,
        code
    );
}

static bool axonkey_device_is_seized(AxonkeyInputState *state, IOHIDDeviceRef device) {
    return state->seized_devices != NULL && CFSetContainsValue(state->seized_devices, device);
}

static bool axonkey_device_is_monitored(AxonkeyInputState *state, IOHIDDeviceRef device) {
    return state->monitored_devices != NULL && CFSetContainsValue(state->monitored_devices, device);
}

static int axonkey_capture_mode(AxonkeyInputState *state) {
    if (state == NULL || !state->capture) {
        return AXONKEY_CAPTURE_NONE;
    }
    if (CFSetGetCount(state->seized_devices) > 0) {
        return AXONKEY_CAPTURE_SEIZED;
    }
    if (state->event_tap != NULL && CFSetGetCount(state->monitored_devices) > 0) {
        return AXONKEY_CAPTURE_FILTERED;
    }
    return AXONKEY_CAPTURE_NONE;
}

static void axonkey_device_matched(
    void *context,
    IOReturn result,
    void *sender,
    IOHIDDeviceRef device
) {
    (void)sender;
    AxonkeyInputState *state = context;
    if (state == NULL || device == NULL) {
        return;
    }
    if (result != kIOReturnSuccess) {
        axonkey_emit(state, AXONKEY_EVENT_BACKEND_ERROR, 0, NULL, 0, result);
        return;
    }
    CFSetAddValue(state->devices, device);

    int capture_mode = AXONKEY_CAPTURE_NONE;
    if (state->capture && !axonkey_device_is_seized(state, device)) {
        IOReturn open_result = IOHIDDeviceOpen(device, kIOHIDOptionsTypeSeizeDevice);
        if (open_result == kIOReturnSuccess) {
            CFSetAddValue(state->seized_devices, device);
        } else if (state->event_tap != NULL) {
            IOReturn monitor_result = IOHIDDeviceOpen(device, kIOHIDOptionsTypeNone);
            if (monitor_result == kIOReturnSuccess) {
                CFSetAddValue(state->monitored_devices, device);
            } else if (axonkey_capture_mode(state) == AXONKEY_CAPTURE_NONE) {
                axonkey_emit(state, AXONKEY_EVENT_BACKEND_ERROR, 0, NULL, 0, monitor_result);
            }
        } else if (axonkey_capture_mode(state) == AXONKEY_CAPTURE_NONE) {
            axonkey_emit(state, AXONKEY_EVENT_BACKEND_ERROR, 0, NULL, 0, open_result);
        }
    }
    capture_mode = axonkey_capture_mode(state);
    axonkey_emit(
        state,
        AXONKEY_EVENT_DEVICE_CONNECTED,
        0,
        NULL,
        0,
        capture_mode
    );
}

static void axonkey_device_removed(
    void *context,
    IOReturn result,
    void *sender,
    IOHIDDeviceRef device
) {
    (void)result;
    (void)sender;
    AxonkeyInputState *state = context;
    if (state == NULL || device == NULL) {
        return;
    }
    if (axonkey_device_is_seized(state, device)) {
        IOHIDDeviceClose(device, kIOHIDOptionsTypeNone);
        CFSetRemoveValue(state->seized_devices, device);
    }
    if (axonkey_device_is_monitored(state, device)) {
        IOHIDDeviceClose(device, kIOHIDOptionsTypeNone);
        CFSetRemoveValue(state->monitored_devices, device);
    }
    CFSetRemoveValue(state->devices, device);
    if (CFSetGetCount(state->devices) == 0) {
        state->pending_event_count = 0;
        state->held_event_count = 0;
        state->active_usage_count = 0;
        axonkey_emit(state, AXONKEY_EVENT_DEVICE_DISCONNECTED, 0, NULL, 0, 0);
    } else {
        axonkey_emit(
            state,
            AXONKEY_EVENT_DEVICE_CONNECTED,
            0,
            NULL,
            0,
            axonkey_capture_mode(state)
        );
    }
}

static void axonkey_input_report(
    void *context,
    IOReturn result,
    void *sender,
    IOHIDReportType type,
    uint32_t report_id,
    uint8_t *report,
    CFIndex report_length
) {
    (void)type;
    AxonkeyInputState *state = context;
    if (state == NULL || sender == NULL || report == NULL || report_length <= 0) {
        return;
    }
    if (result != kIOReturnSuccess) {
        axonkey_emit(state, AXONKEY_EVENT_BACKEND_ERROR, 0, NULL, 0, result);
        return;
    }
    IOHIDDeviceRef device = (IOHIDDeviceRef)sender;
    bool seized = axonkey_device_is_seized(state, device);
    bool monitored = axonkey_device_is_monitored(state, device);
    if (state->capture && !seized && !monitored) {
        return;
    }
    if (state->capture && monitored) {
        axonkey_arm_report_events(state, report_id, report, (size_t)report_length);
    }
    axonkey_emit(
        state,
        AXONKEY_EVENT_INPUT_REPORT,
        report_id,
        report,
        (size_t)report_length,
        0
    );
}

static void axonkey_close_seized_device(const void *value, void *context) {
    (void)context;
    IOHIDDeviceClose((IOHIDDeviceRef)value, kIOHIDOptionsTypeNone);
}

int axonkey_macos_input_run(const AxonkeyCallbacks *callbacks, bool capture) {
    if (callbacks == NULL || callbacks->should_stop == NULL || callbacks->on_event == NULL) {
        return kIOReturnBadArgument;
    }

    IOHIDManagerRef manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
    if (manager == NULL) {
        return kIOReturnNoMemory;
    }
    CFMutableSetRef devices = CFSetCreateMutable(kCFAllocatorDefault, 0, &kCFTypeSetCallBacks);
    CFMutableSetRef seized_devices = CFSetCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeSetCallBacks
    );
    CFMutableSetRef monitored_devices = CFSetCreateMutable(
        kCFAllocatorDefault,
        0,
        &kCFTypeSetCallBacks
    );
    if (devices == NULL || seized_devices == NULL || monitored_devices == NULL) {
        if (devices != NULL) CFRelease(devices);
        if (seized_devices != NULL) CFRelease(seized_devices);
        if (monitored_devices != NULL) CFRelease(monitored_devices);
        CFRelease(manager);
        return kIOReturnNoMemory;
    }

    AxonkeyInputState state = {
        .callbacks = callbacks,
        .capture = capture,
        .devices = devices,
        .seized_devices = seized_devices,
        .monitored_devices = monitored_devices,
    };

    int vendor_id = 0x2717;
    int product_id = 0x32b8;
    CFNumberRef vendor = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &vendor_id);
    CFNumberRef product = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &product_id);
    if (vendor == NULL || product == NULL) {
        if (vendor != NULL) CFRelease(vendor);
        if (product != NULL) CFRelease(product);
        CFRelease(monitored_devices);
        CFRelease(seized_devices);
        CFRelease(devices);
        CFRelease(manager);
        return kIOReturnNoMemory;
    }
    const void *keys[] = {CFSTR(kIOHIDVendorIDKey), CFSTR(kIOHIDProductIDKey)};
    const void *values[] = {vendor, product};
    CFDictionaryRef matching = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        2,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    if (vendor != NULL) CFRelease(vendor);
    if (product != NULL) CFRelease(product);
    if (matching == NULL) {
        CFRelease(monitored_devices);
        CFRelease(seized_devices);
        CFRelease(devices);
        CFRelease(manager);
        return kIOReturnNoMemory;
    }

    IOHIDManagerSetDeviceMatching(manager, matching);
    CFRelease(matching);
    IOHIDManagerRegisterDeviceMatchingCallback(manager, axonkey_device_matched, &state);
    IOHIDManagerRegisterDeviceRemovalCallback(manager, axonkey_device_removed, &state);
    IOHIDManagerRegisterInputReportCallback(manager, axonkey_input_report, &state);
    CFRunLoopRef run_loop = CFRunLoopGetCurrent();
    IOHIDManagerScheduleWithRunLoop(manager, run_loop, kCFRunLoopDefaultMode);
    if (capture) {
        axonkey_start_event_filter(&state, run_loop);
    }

    IOReturn result = IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone);
    if (result == kIOReturnSuccess) {
        axonkey_emit(&state, AXONKEY_EVENT_BACKEND_READY, 0, NULL, 0, 0);
        while (!callbacks->should_stop(callbacks->context)) {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.025, true);
            axonkey_emit(&state, AXONKEY_EVENT_TICK, 0, NULL, 0, 0);
        }
    }

    CFSetApplyFunction(seized_devices, axonkey_close_seized_device, NULL);
    CFSetRemoveAllValues(seized_devices);
    CFSetApplyFunction(monitored_devices, axonkey_close_seized_device, NULL);
    CFSetRemoveAllValues(monitored_devices);
    axonkey_stop_event_filter(&state, run_loop);
    IOHIDManagerUnscheduleFromRunLoop(manager, run_loop, kCFRunLoopDefaultMode);
    IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
    CFRelease(monitored_devices);
    CFRelease(seized_devices);
    CFRelease(devices);
    CFRelease(manager);
    return result;
}

bool axonkey_macos_input_monitoring_granted(void) {
    return IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted;
}

bool axonkey_macos_accessibility_granted(void) {
    return AXIsProcessTrusted();
}

bool axonkey_macos_request_input_monitoring(void) {
    return IOHIDRequestAccess(kIOHIDRequestTypeListenEvent);
}

bool axonkey_macos_request_accessibility(void) {
    const void *keys[] = {kAXTrustedCheckOptionPrompt};
    const void *values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    bool trusted = AXIsProcessTrustedWithOptions(options);
    if (options != NULL) CFRelease(options);
    return trusted;
}

bool axonkey_macos_post_key(uint16_t code, bool down, uint64_t flags, bool autorepeat) {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (source == NULL) {
        return false;
    }
    CGEventRef event = CGEventCreateKeyboardEvent(source, code, down);
    CFRelease(source);
    if (event == NULL) {
        return false;
    }
    CGEventSetIntegerValueField(
        event,
        kCGEventSourceUserData,
        AXONKEY_SYNTHETIC_EVENT_MARKER
    );
    CGEventSetFlags(event, (CGEventFlags)flags);
    if (autorepeat) {
        CGEventSetIntegerValueField(event, kCGKeyboardEventAutorepeat, 1);
    }
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    return true;
}

bool axonkey_macos_post_system_key(int kind, bool down) {
    @autoreleasepool {
        int edge = down ? NX_KEYDOWN : NX_KEYUP;
        int data1 = (kind << 16) | (edge << 8);
        NSEvent *event = [NSEvent otherEventWithType:NSEventTypeSystemDefined
                                            location:NSZeroPoint
                                       modifierFlags:0
                                           timestamp:[NSProcessInfo processInfo].systemUptime
                                        windowNumber:0
                                             context:nil
                                             subtype:8
                                               data1:data1
                                               data2:-1];
        CGEventRef cg_event = event.CGEvent;
        if (cg_event == NULL) {
            return false;
        }
        CGEventSetIntegerValueField(
            cg_event,
            kCGEventSourceUserData,
            AXONKEY_SYNTHETIC_EVENT_MARKER
        );
        CGEventPost(kCGHIDEventTap, cg_event);
        return true;
    }
}

bool axonkey_macos_post_text(const uint16_t *text, size_t length) {
    if (text == NULL || length == 0) {
        return false;
    }
    const size_t chunk_size = 20;
    for (size_t offset = 0; offset < length; offset += chunk_size) {
        size_t count = length - offset;
        if (count > chunk_size) count = chunk_size;
        CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
        CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
        if (down == NULL || up == NULL) {
            if (down != NULL) CFRelease(down);
            if (up != NULL) CFRelease(up);
            return false;
        }
        CGEventSetIntegerValueField(
            down,
            kCGEventSourceUserData,
            AXONKEY_SYNTHETIC_EVENT_MARKER
        );
        CGEventSetIntegerValueField(
            up,
            kCGEventSourceUserData,
            AXONKEY_SYNTHETIC_EVENT_MARKER
        );
        CGEventKeyboardSetUnicodeString(down, count, (const UniChar *)(text + offset));
        CGEventKeyboardSetUnicodeString(up, count, (const UniChar *)(text + offset));
        CGEventPost(kCGHIDEventTap, down);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(down);
        CFRelease(up);
    }
    return true;
}
