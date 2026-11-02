#import <CoreFoundation/CoreFoundation.h>
#import <IOKit/IOKitLib.h>
#include <stdbool.h>
#include <stdint.h>

bool axonkey_hid_bluetooth_address(uint64_t registry_id, char *output, size_t capacity) {
    io_service_t service = IOServiceGetMatchingService(0, IORegistryEntryIDMatching(registry_id));
    if (!service) return false;
    CFTypeRef address = IORegistryEntrySearchCFProperty(service, kIOServicePlane,
        CFSTR("DeviceAddress"), kCFAllocatorDefault, kIORegistryIterateRecursively | kIORegistryIterateParents);
    IOObjectRelease(service);
    if (!address) return false;
    bool valid = CFGetTypeID(address) == CFStringGetTypeID()
        && CFStringGetCString((CFStringRef)address, output, capacity, kCFStringEncodingUTF8);
    CFRelease(address);
    return valid;
}
