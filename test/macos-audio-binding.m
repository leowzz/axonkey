#import <Foundation/Foundation.h>
#import "../src-tauri/native/devices/xiaomi_remote/macos_audio.m"
#include <assert.h>

// Only the OS transport is substituted; selection and callbacks run on the real bridge.
@interface BindingPeripheral : NSObject
@property(nonatomic, strong) NSData *address;
@property(nonatomic, weak) id delegate;
@end
@implementation BindingPeripheral
- (NSString *)name { return @"Xiaomi RC003"; }
- (CBPeripheralState)state { return CBPeripheralStateConnected; }
@end

@interface BindingCentral : NSObject
@property(nonatomic, copy) NSArray *connected;
@property(nonatomic, strong) id selected;
@property(nonatomic, weak) id delegate;
@property(nonatomic) NSUInteger scans;
@property(nonatomic) NSUInteger addressReads;
@property(nonatomic) BOOL unsupported;
@end
@implementation BindingCentral
- (CBManagerState)state { return CBManagerStatePoweredOn; }
- (BOOL)respondsToSelector:(SEL)selector {
    if (selector == @selector(retrieveAddressForPeripheral:) && self.unsupported) return NO;
    return [super respondsToSelector:selector];
}
- (NSData *)retrieveAddressForPeripheral:(BindingPeripheral *)peripheral {
    self.addressReads++;
    return peripheral.address;
}
- (NSArray *)retrieveConnectedPeripheralsWithServices:(NSArray *)services { return self.connected; }
- (void)scanForPeripheralsWithServices:(NSArray *)services options:(NSDictionary *)options { self.scans++; }
- (void)stopScan {}
- (void)connectPeripheral:(id)peripheral options:(NSDictionary *)options { self.selected = peripheral; }
- (void)cancelPeripheralConnection:(id)peripheral { self.selected = nil; }
@end

static AKMacAudioBridge *Bridge(NSString *address, BindingCentral *central) {
    void *raw = axonkey_macos_audio_create(NULL, false, address.UTF8String);
    AKMacAudioBridge *bridge = (__bridge_transfer AKMacAudioBridge *)raw;
    [bridge setValue:central forKey:@"central"];
    [bridge setValue:@YES forKey:@"shouldRun"];
    return bridge;
}

static void Advertise(AKMacAudioBridge *bridge, BindingCentral *central, BindingPeripheral *peripheral) {
    [bridge centralManager:(id)central didDiscoverPeripheral:(id)peripheral
        advertisementData:@{CBAdvertisementDataServiceUUIDsKey: @[[CBUUID UUIDWithString:AKServiceUUIDString]]}
        RSSI:@(-50)];
}

int main(void) {
    @autoreleasepool {
        const uint8_t expected[] = {0xaa, 0xbb, 0xcc, 0xdd, 0xee, 1};
        NSData *firstAddress = [NSData dataWithBytes:expected length:6];
        for (NSString *address in @[@"aa:bb:cc:dd:ee:01", @"AA-BB-CC-DD-EE-01", @"AABBCCDDEE01"]) {
            assert([AKParseBluetoothAddress(address) isEqualToData:firstAddress]);
        }
        for (NSString *invalid in @[@"", @"20190620", @"AABBCCDDEEXX", @"AABBCCDDEE0011"]) {
            assert(AKParseBluetoothAddress(invalid) == nil);
        }
        BindingPeripheral *first = [BindingPeripheral new]; first.address = firstAddress;
        BindingPeripheral *second = [BindingPeripheral new];
        second.address = AKParseBluetoothAddress(@"AA:BB:CC:DD:EE:02");
        BindingCentral *one = [BindingCentral new]; one.connected = @[second, first];
        BindingCentral *two = [BindingCentral new]; two.connected = @[first, second];
        AKMacAudioBridge *bridgeOne = Bridge(@"aa-bb-cc-dd-ee-01", one);
        AKMacAudioBridge *bridgeTwo = Bridge(@"AABBCCDDEE02", two);
        [bridgeOne discoverOrScan]; [bridgeTwo discoverOrScan];
        assert(one.selected == first && two.selected == second);
        assert(one.scans == 0 && two.scans == 0);
        assert([[bridgeOne valueForKey:@"targetAddress"] isEqualToData:firstAddress]);

        [bridgeOne centralManager:(id)one didDisconnectPeripheral:(id)first error:nil];
        one.selected = nil; one.connected = @[second];
        [bridgeOne discoverOrScan];
        assert(one.selected == nil && one.scans == 1);
        Advertise(bridgeOne, one, second);
        assert(one.selected == nil);
        BindingPeripheral *unknown = [BindingPeripheral new];
        Advertise(bridgeOne, one, unknown);
        assert(one.selected == nil && bridgeOne.currentState == AKAudioStateError);
        unknown.address = [NSData dataWithBytes:expected length:5];
        Advertise(bridgeOne, one, unknown);
        assert(one.selected == nil);
        Advertise(bridgeOne, one, first);
        assert(one.selected == first && bridgeOne.currentError == nil);

        for (NSString *invalid in @[@"", @"invalid"]) {
            BindingCentral *central = [BindingCentral new]; central.connected = @[first];
            AKMacAudioBridge *bridge = Bridge(invalid, central);
            [bridge discoverOrScan];
            assert(bridge.currentState == AKAudioStateError && bridge.currentError.length > 0);
            assert(central.selected == nil && central.scans == 0 && central.addressReads == 0);
            [bridge stop];
        }
        BindingCentral *unsupported = [BindingCentral new];
        unsupported.unsupported = YES; unsupported.connected = @[first];
        AKMacAudioBridge *unavailable = Bridge(@"AABBCCDDEE01", unsupported);
        [unavailable discoverOrScan];
        assert(unavailable.currentState == AKAudioStateError);
        assert(unsupported.selected == nil && unsupported.scans == 0 && unsupported.addressReads == 0);

        BindingCentral *legacy = [BindingCentral new]; legacy.connected = @[second, first];
        legacy.unsupported = YES;
        AKMacAudioBridge *unscoped = Bridge(nil, legacy);
        [unscoped discoverOrScan];
        assert(legacy.selected == second && legacy.addressReads == 0);
        [bridgeOne stop]; [bridgeTwo stop]; [unavailable stop]; [unscoped stop];
        puts("RC003 binding: connected=1 scan=1 reconnect=1 missing=1 unsupported=1 legacy=1");
    }
    return 0;
}
