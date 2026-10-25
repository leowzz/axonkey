#import <Foundation/Foundation.h>

#import "../src-tauri/native/devices/xiaomi_remote/macos_audio.m"

@interface AKFakeBatteryCharacteristic : NSObject
@property(nonatomic, strong) CBUUID *UUID;
@property(nonatomic) CBCharacteristicProperties properties;
@property(nonatomic, strong) NSData *value;
@property(nonatomic) BOOL isNotifying;
@end
@implementation AKFakeBatteryCharacteristic
@end

@interface AKFakeBatteryService : NSObject
@property(nonatomic, strong) CBUUID *UUID;
@property(nonatomic, strong) NSArray *characteristics;
@end
@implementation AKFakeBatteryService
@end

@interface AKFakeBatteryPeripheral : NSObject
@property(nonatomic) CBPeripheralState state;
@property(nonatomic, weak) id delegate;
@property(nonatomic, strong) NSArray *services;
@property(nonatomic) NSUInteger reads;
@property(nonatomic) NSUInteger notifications;
@property(nonatomic) BOOL readOnMainThread;
- (void)readValueForCharacteristic:(CBCharacteristic *)characteristic;
- (void)setNotifyValue:(BOOL)notify forCharacteristic:(CBCharacteristic *)characteristic;
- (void)discoverCharacteristics:(NSArray *)UUIDs forService:(CBService *)service;
@end
@implementation AKFakeBatteryPeripheral
- (void)readValueForCharacteristic:(CBCharacteristic *)characteristic {
    (void)characteristic;
    self.reads += 1;
    self.readOnMainThread = [NSThread isMainThread];
}
- (void)setNotifyValue:(BOOL)notify forCharacteristic:(CBCharacteristic *)characteristic {
    (void)characteristic;
    if (notify) self.notifications += 1;
}
- (void)discoverCharacteristics:(NSArray *)UUIDs forService:(CBService *)service {
    (void)UUIDs;
    (void)service;
}
@end

@interface AKTestBatteryBridge : AKMacAudioBridge
@property(nonatomic, strong) NSMutableArray<NSString *> *messages;
@end
@implementation AKTestBatteryBridge
- (void)logAudio:(NSString *)message error:(BOOL)error {
    (void)error;
    if (self.messages == nil) self.messages = [NSMutableArray array];
    [self.messages addObject:message];
}
@end

#define REQUIRE(condition, message) do { \
    if (!(condition)) { fprintf(stderr, "%s (line %d)\n", message, __LINE__); return 1; } \
} while (0)

static AKFakeBatteryCharacteristic *Characteristic(CBCharacteristicProperties properties) {
    AKFakeBatteryCharacteristic *characteristic = [AKFakeBatteryCharacteristic new];
    characteristic.UUID = [CBUUID UUIDWithString:@"2A19"];
    characteristic.properties = properties;
    return characteristic;
}

static AKFakeBatteryService *BatteryService(NSArray *characteristics) {
    AKFakeBatteryService *service = [AKFakeBatteryService new];
    service.UUID = [CBUUID UUIDWithString:@"180F"];
    service.characteristics = characteristics;
    return service;
}

static AKTestBatteryBridge *Bridge(AKFakeBatteryPeripheral *peripheral) {
    AKTestBatteryBridge *bridge = [[AKTestBatteryBridge alloc] initWithCallbacks:NULL];
    [bridge setValue:@YES forKey:@"shouldRun"];
    [bridge setValue:peripheral forKey:@"peripheral"];
    return bridge;
}

static void Discover(AKTestBatteryBridge *bridge, AKFakeBatteryPeripheral *peripheral,
                     AKFakeBatteryCharacteristic *characteristic) {
    [bridge peripheral:(CBPeripheral *)peripheral
        didDiscoverCharacteristicsForService:(CBService *)BatteryService(@[characteristic]) error:nil];
}

static void Deliver(AKTestBatteryBridge *bridge, AKFakeBatteryPeripheral *peripheral,
                    AKFakeBatteryCharacteristic *characteristic, int level, NSError *error) {
    uint8_t byte = (uint8_t)level;
    characteristic.value = level < 0 ? nil : [NSData dataWithBytes:&byte length:1];
    [bridge peripheral:(CBPeripheral *)peripheral
        didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic error:error];
}

static void ExpireGate(AKTestBatteryBridge *bridge) {
    [bridge setValue:@0 forKey:@"nextBatteryReadAt"];
}

static int CheckReadsAndReconnect(void) {
    AKFakeBatteryPeripheral *peripheral = [AKFakeBatteryPeripheral new];
    peripheral.state = CBPeripheralStateConnected;
    AKTestBatteryBridge *bridge = Bridge(peripheral);
    REQUIRE([bridge currentBatteryLevel] == -1 && peripheral.reads == 0,
            "missing characteristic cannot initiate a read or invent a percentage");
    AKFakeBatteryCharacteristic *characteristic = Characteristic(CBCharacteristicPropertyRead);
    Discover(bridge, peripheral, characteristic);
    REQUIRE(peripheral.reads == 1 && peripheral.notifications == 0 && peripheral.readOnMainThread,
            "read-only battery characteristic must be read once on discovery on the main thread");
    REQUIRE([bridge currentBatteryLevel] == -1 && peripheral.reads == 1,
            "polling while the first read is pending must not duplicate requests");
    Deliver(bridge, peripheral, characteristic, 82, nil);
    REQUIRE([bridge currentBatteryLevel] == 82 && peripheral.reads == 1,
            "a read result must be visible without a notification subscription");
    NSUInteger messages = bridge.messages.count;
    Deliver(bridge, peripheral, characteristic, 82, nil);
    REQUIRE(bridge.messages.count == messages, "an unchanged percentage must not repeat success logs");
    REQUIRE([[bridge valueForKey:@"nextBatteryReadAt"] doubleValue] -
            NSProcessInfo.processInfo.systemUptime > 29.0, "successful reads must wait 30 seconds");

    ExpireGate(bridge);
    REQUIRE([bridge currentBatteryLevel] == 82 && peripheral.reads == 2,
            "the getter must refresh a read-only battery after the throttle expires");
    NSError *error = [NSError errorWithDomain:@"BatteryTest" code:1
                                    userInfo:@{NSLocalizedDescriptionKey: @"temporary failure"}];
    Deliver(bridge, peripheral, characteristic, -1, error);
    REQUIRE([bridge currentBatteryLevel] == 82 && peripheral.reads == 2,
            "a transient error must preserve the known percentage without an immediate retry");
    NSTimeInterval retry = [[bridge valueForKey:@"nextBatteryReadAt"] doubleValue] -
        NSProcessInfo.processInfo.systemUptime;
    REQUIRE(retry > 4.0 && retry <= 5.0, "the first failure must use a bounded short retry");
    ExpireGate(bridge);
    [bridge currentBatteryLevel];
    REQUIRE(peripheral.reads == 3, "a failed first read must be retried on the same peripheral");
    Deliver(bridge, peripheral, characteristic, 101, nil);
    REQUIRE([bridge currentBatteryLevel] == 82, "an invalid percentage must preserve the valid cache");
    ExpireGate(bridge);
    [bridge currentBatteryLevel];
    REQUIRE(peripheral.reads == 4, "the second failure must permit one more short retry");
    ExpireGate(bridge); // The in-flight request never received a callback.
    [bridge currentBatteryLevel];
    REQUIRE(peripheral.reads == 4, "a timed-out request must enter backoff before another read");
    REQUIRE([[bridge valueForKey:@"nextBatteryReadAt"] doubleValue] -
            NSProcessInfo.processInfo.systemUptime > 29.0, "repeated failures must back off to 30 seconds");
    ExpireGate(bridge);
    [bridge currentBatteryLevel];
    Deliver(bridge, peripheral, characteristic, 81, nil);
    REQUIRE([bridge currentBatteryLevel] == 81 && [[bridge valueForKey:@"batteryReadFailures"] unsignedIntegerValue] == 0,
            "a changed valid reading must reset failure backoff");

    ExpireGate(bridge);
    [bridge currentBatteryLevel]; // Reconnect must also clear an in-flight read.
    Deliver(bridge, peripheral, characteristic, -1, error);
    ExpireGate(bridge);
    [bridge currentBatteryLevel];
    [bridge resetPeripheral];
    REQUIRE([bridge currentBatteryLevel] == -1 && ![[bridge valueForKey:@"batteryReadPending"] boolValue],
            "disconnect must clear the cached percentage and pending state");
    REQUIRE([[bridge valueForKey:@"batteryReadFailures"] unsignedIntegerValue] == 0,
            "a new connection must not inherit an earlier failure backoff");
    AKFakeBatteryPeripheral *reconnected = [AKFakeBatteryPeripheral new];
    reconnected.state = CBPeripheralStateConnected;
    [bridge setValue:reconnected forKey:@"peripheral"];
    Discover(bridge, reconnected, characteristic);
    REQUIRE(reconnected.reads == 1, "a reconnect must read immediately instead of inheriting old throttle");
    Deliver(bridge, peripheral, characteristic, 50, nil);
    REQUIRE([bridge currentBatteryLevel] == -1, "late data from the previous connection must be ignored");
    Deliver(bridge, reconnected, characteristic, 0, nil);
    REQUIRE([bridge currentBatteryLevel] == 0, "zero percent is a valid read result");
    [bridge setValue:@NO forKey:@"shouldRun"];
    ExpireGate(bridge);
    [bridge currentBatteryLevel];
    REQUIRE(reconnected.reads == 1, "a paused bridge must not initiate battery reads");
    return 0;
}

static int CheckNotificationsAndDiagnostics(void) {
    AKFakeBatteryPeripheral *peripheral = [AKFakeBatteryPeripheral new];
    peripheral.state = CBPeripheralStateConnecting;
    AKTestBatteryBridge *bridge = Bridge(peripheral);
    AKFakeBatteryCharacteristic *characteristic = Characteristic(CBCharacteristicPropertyRead);
    Discover(bridge, peripheral, characteristic);
    [bridge currentBatteryLevel];
    REQUIRE(peripheral.reads == 0, "a peripheral that is still connecting must not be read");
    peripheral.state = CBPeripheralStateConnected;
    [bridge currentBatteryLevel];
    REQUIRE(peripheral.reads == 1, "reading may start after the existing peripheral connects");
    Deliver(bridge, peripheral, characteristic, -1, nil);
    REQUIRE([bridge currentBatteryLevel] == -1, "an empty first result must remain unknown");
    REQUIRE([bridge.messages.lastObject containsString:@"invalid percentage"], "empty results need a diagnostic");
    ExpireGate(bridge);
    [bridge currentBatteryLevel];
    Deliver(bridge, peripheral, characteristic, 70, nil);
    REQUIRE(peripheral.reads == 2 && [bridge currentBatteryLevel] == 70,
            "a failed initial read must recover on retry without reconnecting");

    AKFakeBatteryService *voiceService = [AKFakeBatteryService new];
    voiceService.UUID = [CBUUID UUIDWithString:AKServiceUUIDString];
    peripheral.services = @[voiceService];
    [bridge peripheral:(CBPeripheral *)peripheral didDiscoverServices:nil];
    REQUIRE([bridge.messages.lastObject containsString:@"180F was not found"], "missing battery service needs a diagnostic");
    [bridge peripheral:(CBPeripheral *)peripheral
        didDiscoverCharacteristicsForService:(CBService *)BatteryService(@[]) error:nil];
    REQUIRE([bridge.messages.lastObject containsString:@"2A19 was not found"], "missing battery characteristic needs a diagnostic");

    [bridge resetPeripheral];
    [bridge setValue:peripheral forKey:@"peripheral"];
    characteristic = Characteristic(CBCharacteristicPropertyNotify);
    Discover(bridge, peripheral, characteristic);
    NSUInteger reads = peripheral.reads;
    REQUIRE(peripheral.notifications == 1, "a notify-only characteristic should subscribe");
    Deliver(bridge, peripheral, characteristic, 60, nil);
    ExpireGate(bridge);
    REQUIRE([bridge currentBatteryLevel] == 60 && peripheral.reads == reads,
            "a notify-only characteristic must not receive unsupported read requests");
    [bridge peripheral:(CBPeripheral *)peripheral
        didUpdateNotificationStateForCharacteristic:(CBCharacteristic *)characteristic
        error:[NSError errorWithDomain:@"BatteryTest" code:2 userInfo:nil]];
    REQUIRE([bridge currentState] == AKAudioStateStopped && [bridge currentBatteryLevel] == 60,
            "battery notification errors must not change audio state or drop its connection");
    REQUIRE([bridge valueForKey:@"peripheral"] == peripheral, "battery failures must not disconnect the voice peripheral");
    return 0;
}

static int Check(const uint8_t *bytes, NSUInteger length, int expected) {
    NSData *data = length == 0 ? nil : [NSData dataWithBytes:bytes length:length];
    int actual = AKParseBatteryLevel(data);
    if (actual != expected) {
        fprintf(stderr, "expected %d, got %d\n", expected, actual);
        return 1;
    }
    return 0;
}

int main(void) {
    @autoreleasepool {
        const uint8_t empty[] = {0};
        const uint8_t zero[] = {0};
        const uint8_t full[] = {100};
        const uint8_t invalid[] = {101};
        return Check(empty, 0, -1) || Check(zero, 1, 0) ||
               Check(full, 1, 100) || Check(invalid, 1, -1) ||
               CheckReadsAndReconnect() || CheckNotificationsAndDiagnostics();
    }
}
