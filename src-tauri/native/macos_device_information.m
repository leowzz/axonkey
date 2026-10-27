#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static NSString *AKCompactAddress(NSString *value) {
    return [[[value stringByReplacingOccurrencesOfString:@":" withString:@""]
        stringByReplacingOccurrencesOfString:@"-" withString:@""] uppercaseString];
}

@interface AKDeviceInformation : NSObject
@property(nonatomic, strong) CBPeripheral *peripheral;
@property(nonatomic, strong) NSMutableDictionary *values;
@property(nonatomic, strong) NSMutableArray<NSString *> *errors;
@property(nonatomic) uint16_t vendor;
@property(nonatomic) uint16_t product;
@property(nonatomic) BOOL identified;
@property(nonatomic) NSUInteger pending;
@property(nonatomic) BOOL done;
- (void)acceptValue:(NSData *)data UUID:(NSString *)uuid;
@end
@implementation AKDeviceInformation
- (instancetype)init {
    if ((self = [super init])) { _values = [NSMutableDictionary dictionary]; _errors = [NSMutableArray array]; }
    return self;
}
- (void)acceptValue:(NSData *)data UUID:(NSString *)uuid {
    const uint8_t *bytes = data.bytes;
    if ([uuid isEqualToString:@"2A50"]) {
        // HID exposes the PnP vendor/product pair for both assigned ID sources.
        if (data.length == 7 && (bytes[0] == 1 || bytes[0] == 2)) {
            self.vendor = bytes[1] | ((uint16_t)bytes[2] << 8);
            self.product = bytes[3] | ((uint16_t)bytes[4] << 8);
            self.identified = YES;
        }
        return;
    }
    if ([uuid isEqualToString:@"2A19"]) {
        if (data.length == 1 && bytes[0] <= 100) self.values[@"batteryLevel"] = @(bytes[0]);
        else [self.errors addObject:@"电量数据格式无效"];
        return;
    }
    NSDictionary *keys = @{@"2A29": @"manufacturer", @"2A25": @"serialNumber", @"2A27": @"hardwareRevision",
        @"2A26": @"firmwareRevision", @"2A28": @"softwareRevision"};
    NSString *key = keys[uuid];
    if (key == nil) return;
    NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (value == nil) { [self.errors addObject:@"设备信息不是有效 UTF-8 文本"]; return; }
    NSMutableCharacterSet *trim = [NSMutableCharacterSet whitespaceAndNewlineCharacterSet];
    [trim addCharactersInRange:NSMakeRange(0, 1)];
    value = [value stringByTrimmingCharactersInSet:trim];
    if (value.length) self.values[key] = value;
}
@end

static NSDictionary *AKSelectDeviceInformation(NSArray<AKDeviceInformation *> *devices,
    NSString *address, uint16_t vendor, uint16_t product, BOOL uniqueModel) {
    NSMutableArray<AKDeviceInformation *> *matches = [NSMutableArray array];
    for (AKDeviceInformation *device in devices) {
        if (device.identified && device.vendor == vendor && device.product == product) [matches addObject:device];
    }
    AKDeviceInformation *selected = nil;
    for (AKDeviceInformation *device in matches) {
        NSString *serial = device.values[@"serialNumber"];
        if (serial.length && [AKCompactAddress(serial) isEqualToString:AKCompactAddress(address)]) {
            if (selected != nil) return @{@"error": @"设备序列号冲突，无法匹配设备信息"};
            selected = device;
        }
    }
    // CoreBluetooth does not expose MAC addresses. A model fallback is safe only
    // when both HID discovery and GATT discovery contain a single matching remote.
    if (selected == nil && uniqueModel && matches.count == 1) {
        BOOL unknown = NO;
        for (AKDeviceInformation *device in devices) if (!device.identified) unknown = YES;
        if (!unknown) selected = matches.firstObject;
    }
    if (selected == nil) return @{@"error": @"无法唯一匹配蓝牙设备信息"};
    NSMutableDictionary *result = [selected.values mutableCopy];
    if (selected.errors.count) result[@"error"] = [selected.errors componentsJoinedByString:@"；"];
    return result;
}

@interface AKDeviceInformationReader : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
@property(nonatomic, strong) CBCentralManager *central;
@property(nonatomic, strong) NSMutableDictionary<NSUUID *, AKDeviceInformation *> *devices;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) dispatch_semaphore_t completed;
@property(nonatomic, strong) NSString *failure;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL finished;
- (void)finish;
@end
@implementation AKDeviceInformationReader
- (instancetype)init {
    if ((self = [super init])) {
        _queue = dispatch_queue_create("com.axonkey.device-information", DISPATCH_QUEUE_SERIAL);
        _completed = dispatch_semaphore_create(0);
        _devices = [NSMutableDictionary dictionary];
    }
    return self;
}
- (void)finish {
    if (self.finished) return;
    self.finished = YES;
    dispatch_semaphore_signal(self.completed);
}
- (void)checkCompletion {
    for (AKDeviceInformation *device in self.devices.allValues) if (!device.done) return;
    [self finish];
}
- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    if (self.finished || self.started) return;
    if (central.state == CBManagerStateUnknown || central.state == CBManagerStateResetting) return;
    if (central.state != CBManagerStatePoweredOn) {
        self.failure = central.state == CBManagerStateUnauthorized ? @"请授予蓝牙访问权限" : @"蓝牙不可用";
        [self finish]; return;
    }
    self.started = YES;
    NSArray *peripherals = [central retrieveConnectedPeripheralsWithServices:@[
        [CBUUID UUIDWithString:@"1812"], [CBUUID UUIDWithString:@"180A"],
        [CBUUID UUIDWithString:@"AB5E0001-5A21-4F05-BC7D-AF01F617B664"]]];
    for (CBPeripheral *peripheral in peripherals) {
        AKDeviceInformation *device = [AKDeviceInformation new];
        device.peripheral = peripheral;
        if (peripheral.name.length) device.values[@"bluetoothName"] = peripheral.name;
        self.devices[peripheral.identifier] = device;
        // This central owns its own peripheral delegate; the audio central and
        // system HID client keep their shared physical connection and callbacks.
        peripheral.delegate = self;
        [central connectPeripheral:peripheral options:nil];
    }
    if (peripherals.count == 0) { self.failure = @"未发现已连接的蓝牙设备"; [self finish]; }
}
- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    if (self.finished) return;
    [peripheral discoverServices:@[[CBUUID UUIDWithString:@"180A"], [CBUUID UUIDWithString:@"180F"]]];
}
- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    [device.errors addObject:error.localizedDescription ?: @"蓝牙连接失败"];
    device.done = YES;
    [self checkCompletion];
}
- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    [device.errors addObject:@"设备已断开"];
    device.done = YES;
    [self checkCompletion];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    if (error) { [device.errors addObject:error.localizedDescription]; device.done = YES; [self checkCompletion]; return; }
    NSArray *wanted = @[[CBUUID UUIDWithString:@"2A50"], [CBUUID UUIDWithString:@"2A19"],
        [CBUUID UUIDWithString:@"2A29"], [CBUUID UUIDWithString:@"2A25"], [CBUUID UUIDWithString:@"2A27"],
        [CBUUID UUIDWithString:@"2A26"], [CBUUID UUIDWithString:@"2A28"]];
    for (CBService *service in peripheral.services) {
        if (![service.UUID isEqual:[CBUUID UUIDWithString:@"180A"]] && ![service.UUID isEqual:[CBUUID UUIDWithString:@"180F"]]) continue;
        device.pending += 1;
        [peripheral discoverCharacteristics:wanted forService:service];
    }
    if (!device.pending) { device.done = YES; [self checkCompletion]; }
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    device.pending -= 1;
    if (error) [device.errors addObject:error.localizedDescription];
    else for (CBCharacteristic *characteristic in service.characteristics) {
        if (!(characteristic.properties & CBCharacteristicPropertyRead)) continue;
        device.pending += 1;
        [peripheral readValueForCharacteristic:characteristic];
    }
    if (!device.pending) { device.done = YES; [self checkCompletion]; }
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    device.pending -= 1;
    if (error) [device.errors addObject:error.localizedDescription];
    else [device acceptValue:characteristic.value UUID:characteristic.UUID.UUIDString];
    if (!device.pending) { device.done = YES; [self checkCompletion]; }
}
@end

char *axonkey_device_information(const char *requests_json) {
    @autoreleasepool {
        AKDeviceInformationReader *reader = [AKDeviceInformationReader new];
        dispatch_async(reader.queue, ^{
            reader.central = [[CBCentralManager alloc] initWithDelegate:reader queue:reader.queue
                options:@{CBCentralManagerOptionShowPowerAlertKey: @NO}];
        });
        long timeout = dispatch_semaphore_wait(reader.completed, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
        NSArray *requests = [NSJSONSerialization JSONObjectWithData:
            [[NSString stringWithUTF8String:requests_json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        NSMutableArray *result = [NSMutableArray array];
        dispatch_sync(reader.queue, ^{
            reader.finished = YES;
            for (NSDictionary *request in requests) {
                if (timeout) [result addObject:@{@"error": @"设备信息读取超时"}];
                else if (reader.failure) [result addObject:@{@"error": reader.failure}];
                else [result addObject:AKSelectDeviceInformation(reader.devices.allValues,
                    request[@"address"], [request[@"vendor"] unsignedShortValue],
                    [request[@"product"] unsignedShortValue], [request[@"uniqueModel"] boolValue])];
            }
            for (AKDeviceInformation *device in reader.devices.allValues) {
                device.peripheral.delegate = nil;
                [reader.central cancelPeripheralConnection:device.peripheral];
            }
            reader.central.delegate = nil;
        });
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *string = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        return strdup(string.UTF8String ?: "[]");
    }
}
void axonkey_device_information_free(char *value) { free(value); }
