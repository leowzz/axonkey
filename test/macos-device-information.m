#import "../src-tauri/native/macos_device_information.m"
#include <assert.h>
static NSData *Bytes(const uint8_t *bytes, NSUInteger length) { return [NSData dataWithBytes:bytes length:length]; }
int main(void) {
    @autoreleasepool {
        AKDeviceInformation *first = [AKDeviceInformation new];
        uint8_t pnp[] = {1, 0x16, 0x04, 0, 3, 0, 1};
        [first acceptValue:Bytes(pnp, 7) UUID:@"2A50"];
        assert(first.identified && first.vendor == 0x0416 && first.product == 0x0300);
        [first acceptValue:[@"Maker" dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A29"];
        [first acceptValue:[@"1.0" dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A26"];
        uint8_t battery[] = {0};
        [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
        assert([first.values[@"batteryLevel"] intValue] == 0);
        NSDictionary *result = AKSelectDeviceInformation(@[first], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, YES);
        assert(result[@"error"] == nil && [result[@"manufacturer"] isEqual:@"Maker"]);
        assert(result[@"softwareRevision"] == nil);
        assert(AKSelectDeviceInformation(@[first], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, NO)[@"error"] != nil);
        AKDeviceInformation *second = [AKDeviceInformation new];
        [second acceptValue:Bytes(pnp, 7) UUID:@"2A50"];
        assert(AKSelectDeviceInformation(@[first, second], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, YES)[@"error"] != nil);
        first.values[@"serialNumber"] = @"AA-BB-CC-DD-EE-FF";
        assert(AKSelectDeviceInformation(@[first, second], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, NO)[@"error"] == nil);
        second.values[@"serialNumber"] = first.values[@"serialNumber"];
        assert(AKSelectDeviceInformation(@[first, second], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, NO)[@"error"] != nil);
        battery[0] = 100; [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
        assert([first.values[@"batteryLevel"] intValue] == 100);
        battery[0] = 101; [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
        assert(first.errors.count == 1);
        puts("macOS device information tests passed");
    }
    return 0;
}
