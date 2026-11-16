#import "../src-tauri/native/macos_device_information.m"
#include <assert.h>
#include <stdio.h>

static NSData *Bytes(const uint8_t *bytes, NSUInteger length) {
    return [NSData dataWithBytes:bytes length:length];
}

static void CollectReading(void *context, size_t index, const char *json, bool complete) {
    NSMutableArray *updates = (__bridge NSMutableArray *)context;
    NSDictionary *result = [NSJSONSerialization JSONObjectWithData:
        [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    assert(result != nil);
    [updates addObject:@{@"index": @(index), @"result": result, @"complete": @(complete)}];
}

static AKDeviceInformation *Remote(NSString *serial) {
    AKDeviceInformation *device = [AKDeviceInformation new];
    uint8_t pnp[] = {1, 0x16, 0x04, 0, 3, 0, 1};
    [device acceptValue:Bytes(pnp, 7) UUID:@"2A50"];
    if (serial) [device acceptValue:[serial dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A25"];
    device.servicesDiscovered = YES;
    device.pending = 1;
    return device;
}

static AKDeviceInformationReader *Reader(NSArray<AKDeviceInformation *> *devices,
    NSArray<NSDictionary *> *requests, NSMutableArray *updates) {
    AKDeviceInformationReader *reader = [AKDeviceInformationReader new];
    reader.started = YES;
    reader.requests = requests;
    reader.context = (__bridge void *)updates;
    reader.callback = CollectReading;
    for (AKDeviceInformation *device in devices) reader.devices[[NSUUID UUID]] = device;
    return reader;
}

static NSDictionary *Request(NSString *address, BOOL uniqueModel) {
    return @{@"address": address, @"vendor": @0x0416, @"product": @0x0300, @"uniqueModel": @(uniqueModel)};
}

static void ParsesValuesAndMatchesIdentities(void) {
    AKDeviceInformation *first = Remote(nil);
    assert(first.identified && first.vendor == 0x0416 && first.product == 0x0300);
    [first acceptValue:[@"Maker" dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A29"];
    [first acceptValue:[@"1.0" dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A26"];
    uint8_t battery[] = {0};
    [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
    assert([first.values[@"batteryLevel"] intValue] == 0);
    NSString *error = nil;
    assert(AKMatchDeviceInformation(@[first], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, YES, &error) == first);
    NSDictionary *result = AKDeviceInformationValues(first, nil);
    assert(result[@"error"] == nil && [result[@"manufacturer"] isEqual:@"Maker"]);
    assert(result[@"softwareRevision"] == nil);
    assert(AKMatchDeviceInformation(@[first], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, NO, &error) == nil);
    assert(error != nil);
    AKDeviceInformation *second = Remote(nil);
    assert(AKMatchDeviceInformation(@[first, second], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, YES, &error) == nil);
    first.values[@"serialNumber"] = @"AA-BB-CC-DD-EE-FF";
    assert(AKMatchDeviceInformation(@[first, second], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, NO, &error) == first);
    second.values[@"serialNumber"] = first.values[@"serialNumber"];
    assert(AKMatchDeviceInformation(@[first, second], @"AA:BB:CC:DD:EE:FF", 0x0416, 0x0300, NO, &error) == nil);
    assert([error containsString:@"序列号冲突"]);
    battery[0] = 100;
    [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
    assert([first.values[@"batteryLevel"] intValue] == 100);
    uint8_t invalidText[] = {0xff};
    [first acceptValue:Bytes(invalidText, 1) UUID:@"2A28"];
    assert(first.errors.count == 0);
    battery[0] = 101;
    [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
    assert(first.errors.count == 1);
}

static void PublishesBatteryAndCompletesEachDeviceIndependently(void) {
    AKDeviceInformation *first = Remote(@"AA:BB:CC:DD:EE:01");
    AKDeviceInformation *second = Remote(@"AA:BB:CC:DD:EE:02");
    uint8_t battery[] = {54};
    [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
    NSMutableArray *updates = [NSMutableArray array];
    AKDeviceInformationReader *reader = Reader(@[first, second],
        @[Request(@"AA:BB:CC:DD:EE:01", NO), Request(@"AA:BB:CC:DD:EE:02", NO)], updates);
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 2);
    assert([updates[0][@"result"][@"batteryLevel"] intValue] == 54);
    assert(![updates[0][@"complete"] boolValue] && !first.done && !second.done);
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 2);
    [first acceptValue:[@"FW1" dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A26"];
    first.pending = 0;
    first.done = YES;
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 3);
    assert([updates[2][@"index"] unsignedIntegerValue] == 0 && [updates[2][@"complete"] boolValue]);
    assert([updates[2][@"result"][@"firmwareRevision"] isEqual:@"FW1"]);
    assert(!reader.finished && !second.done);
    [reader publishUpdatesWithError:@"设备信息读取超时"];
    assert(updates.count == 4);
    assert([updates[3][@"index"] unsignedIntegerValue] == 1 && [updates[3][@"complete"] boolValue]);
    assert([updates[3][@"result"][@"error"] containsString:@"超时"]);
    assert(reader.finished);
    [reader publishUpdatesWithError:@"设备信息读取超时"];
    assert(updates.count == 4);
}

static void TimeoutKeepsSafelyMatchedReadings(void) {
    AKDeviceInformation *device = Remote(@"AA:BB:CC:DD:EE:01");
    uint8_t battery[] = {0};
    [device acceptValue:Bytes(battery, 1) UUID:@"2A19"];
    [device acceptValue:[@"Maker" dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A29"];
    NSMutableArray *updates = [NSMutableArray array];
    AKDeviceInformationReader *reader = Reader(@[device], @[Request(@"AA:BB:CC:DD:EE:01", YES)], updates);
    [reader publishUpdatesWithError:nil];
    [reader publishUpdatesWithError:@"设备信息读取超时"];
    assert(updates.count == 2);
    NSDictionary *final = updates.lastObject[@"result"];
    assert(final[@"batteryLevel"] != nil && [final[@"batteryLevel"] intValue] == 0);
    assert([final[@"manufacturer"] isEqual:@"Maker"] && [final[@"error"] containsString:@"超时"]);
    assert([updates.lastObject[@"complete"] boolValue]);
}

static void FinishesRequestedDevicesWithoutWaitingForOtherDetails(void) {
    AKDeviceInformation *first = Remote(@"AA:BB:CC:DD:EE:01");
    AKDeviceInformation *second = Remote(@"AA:BB:CC:DD:EE:02");
    first.done = YES;
    first.pending = 0;
    NSMutableArray *updates = [NSMutableArray array];
    AKDeviceInformationReader *reader = Reader(@[first, second], @[Request(@"AA:BB:CC:DD:EE:01", NO)], updates);
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 1 && [updates[0][@"complete"] boolValue]);
    assert(reader.finished && !second.done);
}

static void WaitsForIdentityWithoutPublishingDuplicateSerials(void) {
    AKDeviceInformation *first = Remote(@"AA:BB:CC:DD:EE:01");
    AKDeviceInformation *second = Remote(nil);
    second.identityPending = 1;
    uint8_t battery[] = {54};
    [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
    NSMutableArray *updates = [NSMutableArray array];
    AKDeviceInformationReader *reader = Reader(@[first, second], @[Request(@"AA:BB:CC:DD:EE:01", NO)], updates);
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 0);
    [second acceptValue:[@"AA-BB-CC-DD-EE-01" dataUsingEncoding:NSUTF8StringEncoding] UUID:@"2A25"];
    second.identityPending = 0;
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 1 && [updates[0][@"complete"] boolValue]);
    assert([updates[0][@"result"][@"error"] containsString:@"序列号冲突"]);
    assert(updates[0][@"result"][@"batteryLevel"] == nil);
}

static void UnresolvedIdentityNeverLeaksFallbackReadings(void) {
    AKDeviceInformation *first = Remote(nil);
    AKDeviceInformation *unknown = [AKDeviceInformation new];
    uint8_t battery[] = {72};
    [first acceptValue:Bytes(battery, 1) UUID:@"2A19"];
    NSMutableArray *updates = [NSMutableArray array];
    AKDeviceInformationReader *reader = Reader(@[first, unknown], @[Request(@"AA:BB:CC:DD:EE:01", YES)], updates);
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 0);
    [reader publishUpdatesWithError:@"设备信息读取超时"];
    assert(updates.count == 1 && [updates[0][@"complete"] boolValue]);
    assert(updates[0][@"result"][@"batteryLevel"] == nil);

    [updates removeAllObjects];
    unknown.done = YES;
    reader = Reader(@[first, unknown], @[Request(@"AA:BB:CC:DD:EE:01", YES)], updates);
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 1 && [updates[0][@"complete"] boolValue]);
    assert([updates[0][@"result"][@"error"] containsString:@"无法唯一匹配"]);
    assert(updates[0][@"result"][@"batteryLevel"] == nil);

    [updates removeAllObjects];
    reader = Reader(@[first, unknown], @[Request(@"AA:BB:CC:DD:EE:01", YES)], updates);
    uint8_t differentModel[] = {1, 0x17, 0x27, 0xb8, 0x32, 0, 1};
    [unknown acceptValue:Bytes(differentModel, 7) UUID:@"2A50"];
    unknown.done = NO;
    unknown.identityPending = 1;
    [reader publishUpdatesWithError:nil];
    assert(updates.count == 1 && ![updates[0][@"complete"] boolValue]);
    assert([updates[0][@"result"][@"batteryLevel"] intValue] == 72);
}

int main(void) {
    @autoreleasepool {
        ParsesValuesAndMatchesIdentities();
        PublishesBatteryAndCompletesEachDeviceIndependently();
        TimeoutKeepsSafelyMatchedReadings();
        FinishesRequestedDevicesWithoutWaitingForOtherDetails();
        WaitsForIdentityWithoutPublishingDuplicateSerials();
        UnresolvedIdentityNeverLeaksFallbackReadings();
        puts("macOS device information tests passed");
    }
    return 0;
}
