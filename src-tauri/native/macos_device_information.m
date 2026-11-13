#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

static NSString *AKCompactAddress(NSString *value) {
    return [[[value stringByReplacingOccurrencesOfString:@":" withString:@""]
        stringByReplacingOccurrencesOfString:@"-" withString:@""] uppercaseString];
}

@interface AKDeviceInformation : NSObject
@property(nonatomic, strong) CBPeripheral *peripheral;
@property(nonatomic, strong) NSMutableDictionary *values;
@property(nonatomic, strong) NSMutableArray<NSString *> *errors;
@property(nonatomic, strong) NSMutableArray<CBCharacteristic *> *details;
@property(nonatomic) uint16_t vendor;
@property(nonatomic) uint16_t product;
@property(nonatomic) BOOL identified;
@property(nonatomic) NSUInteger pending;
@property(nonatomic) NSUInteger servicesPending;
@property(nonatomic) NSUInteger identityPending;
@property(nonatomic) BOOL servicesDiscovered;
@property(nonatomic) BOOL done;
- (void)acceptValue:(NSData *)data UUID:(NSString *)uuid;
- (BOOL)identityReady;
@end
@implementation AKDeviceInformation
- (instancetype)init {
    if ((self = [super init])) {
        _values = [NSMutableDictionary dictionary];
        _errors = [NSMutableArray array];
        _details = [NSMutableArray array];
    }
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
    NSDictionary *keys = @{@"2A29": @"manufacturer", @"2A24": @"modelNumber", @"2A25": @"serialNumber", @"2A27": @"hardwareRevision",
        @"2A26": @"firmwareRevision", @"2A28": @"softwareRevision"};
    NSString *key = keys[uuid];
    if (key == nil) return;
    NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (value == nil) {
        if (![uuid isEqualToString:@"2A28"]) [self.errors addObject:@"设备信息不是有效 UTF-8 文本"];
        return;
    }
    NSMutableCharacterSet *trim = [NSMutableCharacterSet whitespaceAndNewlineCharacterSet];
    [trim addCharactersInRange:NSMakeRange(0, 1)];
    value = [value stringByTrimmingCharactersInSet:trim];
    if (value.length) self.values[key] = value;
}
- (BOOL)identityReady {
    return self.done || (self.servicesDiscovered && self.identityPending == 0);
}
@end

static AKDeviceInformation *AKMatchDeviceInformation(NSArray<AKDeviceInformation *> *devices,
    NSString *address, uint16_t vendor, uint16_t product, BOOL uniqueModel, NSString **error) {
    NSMutableArray<AKDeviceInformation *> *matches = [NSMutableArray array];
    for (AKDeviceInformation *device in devices) {
        if (device.identified && device.vendor == vendor && device.product == product) [matches addObject:device];
    }
    AKDeviceInformation *selected = nil;
    for (AKDeviceInformation *device in matches) {
        NSString *serial = device.values[@"serialNumber"];
        if (serial.length && [AKCompactAddress(serial) isEqualToString:AKCompactAddress(address)]) {
            if (selected != nil) {
                *error = @"设备序列号冲突，无法匹配设备信息";
                return nil;
            }
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
    if (selected == nil) *error = @"无法唯一匹配蓝牙设备信息";
    return selected;
}

static NSDictionary *AKDeviceInformationValues(AKDeviceInformation *device, NSString *terminalError) {
    NSMutableDictionary *result = [device.values mutableCopy];
    NSMutableArray *errors = [device.errors mutableCopy];
    if (terminalError && !device.done) [errors addObject:terminalError];
    if (errors.count) result[@"error"] = [errors componentsJoinedByString:@"；"];
    return result;
}

typedef void (*AKDeviceInformationCallback)(void *context, size_t index, const char *json, bool complete);

@interface AKDeviceInformationReader : NSObject <CBCentralManagerDelegate, CBPeripheralDelegate>
@property(nonatomic, strong) CBCentralManager *central;
@property(nonatomic, strong) NSMutableDictionary<NSUUID *, AKDeviceInformation *> *devices;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) dispatch_semaphore_t completed;
@property(nonatomic, strong) NSArray<NSDictionary *> *requests;
@property(nonatomic, strong) NSMutableIndexSet *completedRequests;
@property(nonatomic, strong) NSMutableDictionary<NSNumber *, NSDictionary *> *publishedValues;
@property(nonatomic) void *context;
@property(nonatomic) AKDeviceInformationCallback callback;
@property(nonatomic) BOOL started;
@property(nonatomic) BOOL finished;
- (void)finish;
- (void)publishUpdatesWithError:(NSString *)terminalError;
@end
@implementation AKDeviceInformationReader
- (instancetype)init {
    if ((self = [super init])) {
        _queue = dispatch_queue_create("com.axonkey.device-information", DISPATCH_QUEUE_SERIAL);
        _completed = dispatch_semaphore_create(0);
        _devices = [NSMutableDictionary dictionary];
        _completedRequests = [NSMutableIndexSet indexSet];
        _publishedValues = [NSMutableDictionary dictionary];
    }
    return self;
}
- (void)finish {
    if (self.finished) return;
    self.finished = YES;
    dispatch_semaphore_signal(self.completed);
}
- (void)publishUpdatesWithError:(NSString *)terminalError {
    if (self.finished) return;
    NSArray<AKDeviceInformation *> *devices = self.devices.allValues;
    // Identity reads must settle before a result is exposed: a later PnP/serial
    // value could otherwise turn an apparent match into a duplicate or fallback conflict.
    for (NSUInteger index = 0; index < self.requests.count; index++) {
        if ([self.completedRequests containsIndex:index]) continue;
        NSDictionary *request = self.requests[index];
        uint16_t vendor = [request[@"vendor"] unsignedShortValue];
        uint16_t product = [request[@"product"] unsignedShortValue];
        BOOL identityReady = self.started;
        for (AKDeviceInformation *device in devices) {
            if (!device.identityReady && (!device.identified || (device.vendor == vendor && device.product == product))) {
                identityReady = NO;
            }
        }
        if (!identityReady && terminalError == nil) continue;
        NSString *error = nil;
        AKDeviceInformation *selected = identityReady ? AKMatchDeviceInformation(devices,
            request[@"address"], vendor, product, [request[@"uniqueModel"] boolValue], &error) : nil;
        BOOL complete = terminalError != nil || selected == nil || selected.done;
        NSString *failure = devices.count == 0 && terminalError ? terminalError : error ?: terminalError;
        NSDictionary *result = selected ? AKDeviceInformationValues(selected, terminalError)
            : @{@"error": failure};
        if (!complete && [self.publishedValues[@(index)] isEqualToDictionary:result]) continue;
        self.publishedValues[@(index)] = result;
        if (complete) [self.completedRequests addIndex:index];
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *string = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        self.callback(self.context, index, string.UTF8String, complete);
    }
    if (self.completedRequests.count == self.requests.count) [self finish];
}
- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    if (self.finished || self.started) return;
    if (central.state == CBManagerStateUnknown || central.state == CBManagerStateResetting) return;
    if (central.state != CBManagerStatePoweredOn) {
        [self publishUpdatesWithError:central.state == CBManagerStateUnauthorized ? @"请授予蓝牙访问权限" : @"蓝牙不可用"];
        return;
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
    if (peripherals.count == 0) [self publishUpdatesWithError:@"未发现已连接的蓝牙设备"];
}
- (void)centralManager:(CBCentralManager *)central didConnectPeripheral:(CBPeripheral *)peripheral {
    if (self.finished) return;
    [peripheral discoverServices:@[[CBUUID UUIDWithString:@"180F"], [CBUUID UUIDWithString:@"180A"]]];
}
- (void)centralManager:(CBCentralManager *)central didFailToConnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    [device.errors addObject:error.localizedDescription ?: @"蓝牙连接失败"];
    device.done = YES;
    [self publishUpdatesWithError:nil];
}
- (void)centralManager:(CBCentralManager *)central didDisconnectPeripheral:(CBPeripheral *)peripheral error:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    if (device.done) return;
    [device.errors addObject:@"设备已断开"];
    device.done = YES;
    [self publishUpdatesWithError:nil];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverServices:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    if (device.done) return;
    if (error) { [device.errors addObject:error.localizedDescription]; device.done = YES; [self publishUpdatesWithError:nil]; return; }
    device.servicesDiscovered = YES;
    NSArray *wanted = @[[CBUUID UUIDWithString:@"2A50"], [CBUUID UUIDWithString:@"2A19"],
        [CBUUID UUIDWithString:@"2A29"], [CBUUID UUIDWithString:@"2A24"], [CBUUID UUIDWithString:@"2A25"], [CBUUID UUIDWithString:@"2A27"],
        [CBUUID UUIDWithString:@"2A26"], [CBUUID UUIDWithString:@"2A28"]];
    for (CBService *service in peripheral.services) {
        if (![service.UUID isEqual:[CBUUID UUIDWithString:@"180A"]] && ![service.UUID isEqual:[CBUUID UUIDWithString:@"180F"]]) continue;
        device.pending += 1;
        device.servicesPending += 1;
        if ([service.UUID isEqual:[CBUUID UUIDWithString:@"180A"]]) device.identityPending += 1;
        [peripheral discoverCharacteristics:wanted forService:service];
    }
    device.done = device.pending == 0;
    [self publishUpdatesWithError:nil];
}
- (void)peripheral:(CBPeripheral *)peripheral didDiscoverCharacteristicsForService:(CBService *)service error:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    if (device.done) return;
    device.pending -= 1;
    device.servicesPending -= 1;
    if ([service.UUID isEqual:[CBUUID UUIDWithString:@"180A"]]) device.identityPending -= 1;
    if (error) [device.errors addObject:error.localizedDescription];
    else for (CBCharacteristic *characteristic in service.characteristics) {
        if (!(characteristic.properties & CBCharacteristicPropertyRead)) continue;
        NSString *uuid = characteristic.UUID.UUIDString;
        BOOL identity = [uuid isEqualToString:@"2A50"] || [uuid isEqualToString:@"2A25"];
        if (!identity && ![uuid isEqualToString:@"2A19"]) {
            [device.details addObject:characteristic];
            continue;
        }
        device.pending += 1;
        if (identity) device.identityPending += 1;
        [peripheral readValueForCharacteristic:characteristic];
    }
    if (device.servicesPending == 0) {
        // Queue identity and battery reads before static details on the same peripheral.
        for (CBCharacteristic *characteristic in device.details) {
            device.pending += 1;
            [peripheral readValueForCharacteristic:characteristic];
        }
        [device.details removeAllObjects];
    }
    device.done = device.pending == 0;
    [self publishUpdatesWithError:nil];
}
- (void)peripheral:(CBPeripheral *)peripheral didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:(NSError *)error {
    if (self.finished) return;
    AKDeviceInformation *device = self.devices[peripheral.identifier];
    if (device.done) return;
    device.pending -= 1;
    NSString *uuid = characteristic.UUID.UUIDString;
    if ([uuid isEqualToString:@"2A50"] || [uuid isEqualToString:@"2A25"]) device.identityPending -= 1;
    if (error) {
        if (![characteristic.UUID.UUIDString isEqualToString:@"2A28"]) {
            [device.errors addObject:error.localizedDescription];
        }
    } else {
        [device acceptValue:characteristic.value UUID:characteristic.UUID.UUIDString];
    }
    device.done = device.pending == 0;
    [self publishUpdatesWithError:nil];
}
@end

void axonkey_device_information_stream(const char *requests_json, void *context, AKDeviceInformationCallback callback) {
    @autoreleasepool {
        AKDeviceInformationReader *reader = [AKDeviceInformationReader new];
        reader.requests = [NSJSONSerialization JSONObjectWithData:
            [[NSString stringWithUTF8String:requests_json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        reader.context = context;
        reader.callback = callback;
        if (reader.requests.count == 0) return;
        dispatch_async(reader.queue, ^{
            reader.central = [[CBCentralManager alloc] initWithDelegate:reader queue:reader.queue
                options:@{CBCentralManagerOptionShowPowerAlertKey: @NO}];
        });
        dispatch_semaphore_wait(reader.completed, dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC));
        dispatch_sync(reader.queue, ^{
            [reader publishUpdatesWithError:@"设备信息读取超时"];
            reader.finished = YES;
            for (AKDeviceInformation *device in reader.devices.allValues) {
                device.peripheral.delegate = nil;
                [reader.central cancelPeripheralConnection:device.peripheral];
            }
            reader.central.delegate = nil;
            reader.callback = NULL;
            reader.context = NULL;
        });
    }
}
