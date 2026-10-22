#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/hid/IOHIDManager.h>
#import <IOKit/hidsystem/IOHIDEventSystemClient.h>
#import <IOKit/hidsystem/IOHIDServiceClient.h>
#include <assert.h>

static CFMutableDictionaryRef service_properties;
static bool service_available, writes_allowed, client_available;
static unsigned int clients_created, write_count, mapping_notifications;
static int last_mapping_status, last_capture_mode;
static char diagnostics[16384];

static IOHIDEventSystemClientRef MockCreateClient(CFAllocatorRef allocator);
static CFArrayRef MockCopyServices(IOHIDEventSystemClientRef client);
static CFTypeRef MockCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
static CFTypeRef MockRegistryID(IOHIDServiceClientRef service);
static Boolean MockSetProperty(IOHIDServiceClientRef service, CFStringRef key, CFTypeRef value);
static IOReturn MockDeviceOpen(IOHIDDeviceRef device, IOOptionBits options);
static IOReturn MockDeviceClose(IOHIDDeviceRef device, IOOptionBits options);

#define IOHIDEventSystemClientCreateSimpleClient MockCreateClient
#define IOHIDEventSystemClientCopyServices MockCopyServices
#define IOHIDServiceClientCopyProperty MockCopyProperty
#define IOHIDServiceClientGetRegistryID MockRegistryID
#define IOHIDServiceClientSetProperty MockSetProperty
#define IOHIDDeviceOpen MockDeviceOpen
#define IOHIDDeviceClose MockDeviceClose
#import "../src-tauri/native/macos_input.m"
#undef IOHIDEventSystemClientCreateSimpleClient
#undef IOHIDEventSystemClientCopyServices
#undef IOHIDServiceClientCopyProperty
#undef IOHIDServiceClientGetRegistryID
#undef IOHIDServiceClientSetProperty
#undef IOHIDDeviceOpen
#undef IOHIDDeviceClose

static IOHIDEventSystemClientRef MockCreateClient(CFAllocatorRef allocator) {
    clients_created++;
    if (!client_available) return NULL;
    // Each client sees the service snapshot available when it was created.
    return (IOHIDEventSystemClientRef)CFRetain(service_available ? kCFBooleanTrue : kCFBooleanFalse);
}

static CFArrayRef MockCopyServices(IOHIDEventSystemClientRef client) {
    const void *services[] = {service_properties};
    return CFArrayCreate(NULL, services, CFBooleanGetValue((CFBooleanRef)client) ? 1 : 0, &kCFTypeArrayCallBacks);
}

static CFTypeRef MockCopyProperty(IOHIDServiceClientRef service, CFStringRef key) {
    CFTypeRef value = CFDictionaryGetValue((CFDictionaryRef)service, key);
    return value == NULL ? NULL : CFRetain(value);
}

static CFTypeRef MockRegistryID(IOHIDServiceClientRef service) {
    return CFDictionaryGetValue((CFDictionaryRef)service, CFSTR("registry"));
}

static Boolean MockSetProperty(IOHIDServiceClientRef service, CFStringRef key, CFTypeRef value) {
    write_count++;
    if (!writes_allowed) return false;
    CFDictionarySetValue((CFMutableDictionaryRef)service, key, value);
    return true;
}

static IOReturn MockDeviceOpen(IOHIDDeviceRef device, IOOptionBits options) {
    return kIOReturnSuccess;
}

static IOReturn MockDeviceClose(IOHIDDeviceRef device, IOOptionBits options) {
    return kIOReturnSuccess;
}

static bool ShouldStop(void *context) { return false; }

static void CaptureEvent(void *context, int event, uint32_t report_id,
    const uint8_t *bytes, size_t length, int code) {
    if (event == AXONKEY_EVENT_MODIFIER_MAPPINGS_CHANGED) {
        mapping_notifications++;
        last_mapping_status = code;
    } else if (event == AXONKEY_EVENT_DEVICE_CONNECTED) {
        last_capture_mode = code;
    } else if (event == AXONKEY_EVENT_MODIFIER_MAPPING_DIAGNOSTIC) {
        size_t offset = strlen(diagnostics);
        snprintf(diagnostics + offset, sizeof(diagnostics) - offset, "%.*s\n", (int)length, bytes);
    }
}

static void SetNumber(CFStringRef key, int64_t value) {
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberSInt64Type, &value);
    CFDictionarySetValue(service_properties, key, number);
    CFRelease(number);
}

static const AxonkeyHardwareModifierMapping mapping = {0x70000003e, 0x7000000e4};
static const AxonkeyHardwareModifierMapping power_guard = {0x700000066, 0x70000006f};
static const AxonkeyCallbacks callbacks = {.should_stop = ShouldStop, .on_event = CaptureEvent};

static AxonkeyInputState NewState(void) {
    service_available = false;
    writes_allowed = client_available = true;
    clients_created = write_count = mapping_notifications = 0;
    diagnostics[0] = '\0';
    service_properties = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SetNumber(CFSTR(kIOHIDVendorIDKey), 0x2717);
    SetNumber(CFSTR(kIOHIDProductIDKey), 0x32b8);
    SetNumber(CFSTR("registry"), 123);
    return (AxonkeyInputState){
        .callbacks = &callbacks, .capture = true,
        .devices = CFSetCreateMutable(NULL, 0, &kCFTypeSetCallBacks),
        .seized_devices = CFSetCreateMutable(NULL, 0, &kCFTypeSetCallBacks),
        .monitored_devices = CFSetCreateMutable(NULL, 0, &kCFTypeSetCallBacks),
        .event_tap = (CFMachPortRef)kCFBooleanTrue,
        .modifier_mappings = &mapping, .modifier_mapping_count = 1,
    };
}

static void FreeState(AxonkeyInputState *state) {
    axonkey_restore_modifier_mappings(state, true);
    if (state->event_system_client) CFRelease(state->event_system_client);
    if (state->original_modifier_mappings) CFRelease(state->original_modifier_mappings);
    CFRelease(state->devices);
    CFRelease(state->seized_devices);
    CFRelease(state->monitored_devices);
    CFRelease(service_properties);
}

static void Connect(AxonkeyInputState *state) {
    axonkey_device_matched(state, kIOReturnSuccess, NULL, (IOHIDDeviceRef)service_properties);
}

static void CheckDelayedService(AxonkeyHardwareModifierMapping requested) {
    AxonkeyInputState state = NewState();
    state.modifier_mappings = &requested;
    Connect(&state);
    assert(!state.modifier_mappings_active && last_mapping_status == 0);
    assert(last_capture_mode == AXONKEY_CAPTURE_FILTERED);
    assert(strstr(diagnostics, "no_matching_hid_service"));
    CFAbsoluteTime due = state.modifier_mapping_retry_at;
    assert(due > 0 && state.modifier_mapping_attempt == 1);
    axonkey_retry_modifier_mappings(&state, due - 0.01);
    assert(state.modifier_mapping_attempt == 1);
    axonkey_retry_modifier_mappings(&state, due);
    assert(state.modifier_mapping_attempt == 2);
    assert(state.modifier_mapping_retry_at == due + 0.5);

    service_available = true;
    axonkey_retry_modifier_mappings(&state, state.modifier_mapping_retry_at);
    assert(state.modifier_mappings_active && last_mapping_status == 1);
    assert(state.modifier_mapping_retry_at == 0 && clients_created == 3);
    assert(mapping_notifications == 3 && strstr(diagnostics, "reason=ready"));
    assert(strstr(diagnostics, "registry_id=0x7b"));
    CFArrayRef installed = CFDictionaryGetValue(service_properties, CFSTR("UserKeyMapping"));
    assert(installed && CFArrayGetCount(installed) == 1);
    CFDictionaryRef expected = axonkey_create_usage_mapping(requested.source, requested.destination);
    assert(CFEqual(expected, CFArrayGetValueAtIndex(installed, 0)));
    CFRelease(expected);
    unsigned int attempts = state.modifier_mapping_attempt;
    axonkey_retry_modifier_mappings(&state, due + 100);
    assert(state.modifier_mapping_attempt == attempts);
    FreeState(&state);
}

static void CheckWriteRejectionAndHeldKey(void) {
    AxonkeyInputState state = NewState();
    service_available = true;
    writes_allowed = false;
    Connect(&state);
    assert(strstr(diagnostics, "property_write_rejected"));
    assert(!state.modifier_mappings_active);
    writes_allowed = true;
    CFAbsoluteTime due = state.modifier_mapping_retry_at;
    state.active_usage_count = 1;
    axonkey_retry_modifier_mappings(&state, due);
    assert(state.modifier_mapping_attempt == 1);
    state.active_usage_count = 0;
    state.pending_event_count = 1;
    state.pending_events[0].expires_at = due + 0.18;
    axonkey_retry_modifier_mappings(&state, due);
    assert(state.modifier_mapping_attempt == 1);
    axonkey_retry_modifier_mappings(&state, due + 0.2);
    assert(state.modifier_mappings_active && last_mapping_status == 1);
    FreeState(&state);
}

static void CheckDisconnectAndBackoff(void) {
    AxonkeyInputState state = NewState();
    Connect(&state);
    for (int i = 0; i < 10; i++) {
        CFAbsoluteTime due = state.modifier_mapping_retry_at;
        axonkey_retry_modifier_mappings(&state, due);
        assert(state.modifier_mapping_retry_at > due);
        assert(state.modifier_mapping_retry_at <= due + 10);
    }
    assert(state.modifier_mapping_retry_delay == 10);
    unsigned int attempts = state.modifier_mapping_attempt;
    axonkey_device_removed(&state, kIOReturnSuccess, NULL, (IOHIDDeviceRef)service_properties);
    assert(state.modifier_mapping_retry_at == 0 && !state.modifier_mappings_active);
    axonkey_retry_modifier_mappings(&state, CFAbsoluteTimeGetCurrent() + 100);
    assert(state.modifier_mapping_attempt == attempts);
    service_available = true;
    SetNumber(CFSTR("registry"), 456);
    Connect(&state);
    assert(state.modifier_mappings_active && state.modifier_mapping_attempt == 1);
    assert(CFDictionaryGetCount(state.original_modifier_mappings) == 1);
    assert(strstr(diagnostics, "registry_id=0x1c8"));
    FreeState(&state);
}

static void CheckClientRecoveryAndDisabledCapture(void) {
    AxonkeyInputState state = NewState();
    client_available = false;
    service_available = true;
    Connect(&state);
    assert(strstr(diagnostics, "hid_client_unavailable"));
    CFAbsoluteTime due = state.modifier_mapping_retry_at;
    state.capture = false;
    axonkey_retry_modifier_mappings(&state, due);
    assert(state.modifier_mapping_attempt == 1);
    state.capture = true;
    client_available = true;
    axonkey_retry_modifier_mappings(&state, due);
    assert(state.modifier_mappings_active);
    FreeState(&state);
}

static void CheckRestoresOnlyManagedMappings(AxonkeyHardwareModifierMapping requested) {
    AxonkeyInputState state = NewState();
    state.modifier_mappings = &requested;
    service_available = true;
    CFDictionaryRef original = axonkey_create_usage_mapping(requested.source, 0x7000000e0);
    CFDictionaryRef unrelated = axonkey_create_usage_mapping(0x700000004, 0x700000005);
    const void *entries[] = {original, unrelated};
    CFArrayRef initial = CFArrayCreate(NULL, entries, 2, &kCFTypeArrayCallBacks);
    CFDictionarySetValue(service_properties, CFSTR("UserKeyMapping"), initial);
    Connect(&state);
    assert(state.modifier_mappings_active);
    // Some service lifetimes outlast a brief device disconnect. Our own
    // installed mapping must not become the new restoration baseline.
    axonkey_device_removed(&state, kIOReturnSuccess, NULL, (IOHIDDeviceRef)service_properties);
    service_available = false;
    Connect(&state);
    assert(!state.modifier_mappings_active);
    assert(CFDictionaryGetCount(state.original_modifier_mappings) == 1);
    service_available = true;
    axonkey_retry_modifier_mappings(&state, state.modifier_mapping_retry_at);
    assert(state.modifier_mappings_active);
    axonkey_restore_modifier_mappings(&state, true);
    CFArrayRef restored = CFDictionaryGetValue(service_properties, CFSTR("UserKeyMapping"));
    assert(CFArrayGetCount(restored) == 2);
    assert(CFArrayContainsValue(restored, CFRangeMake(0, 2), original));
    assert(CFArrayContainsValue(restored, CFRangeMake(0, 2), unrelated));
    CFRelease(initial);
    CFRelease(original);
    CFRelease(unrelated);
    FreeState(&state);
}

int main(void) {
    @autoreleasepool {
        CheckDelayedService(mapping);
        CheckDelayedService(power_guard);
        CheckWriteRejectionAndHeldKey();
        CheckDisconnectAndBackoff();
        CheckClientRecoveryAndDisabledCapture();
        CheckRestoresOnlyManagedMappings(mapping);
        CheckRestoresOnlyManagedMappings(power_guard);
    }
    return 0;
}
