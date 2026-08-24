#import <Foundation/Foundation.h>

#import "../src-tauri/native/macos_audio.m"

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
               Check(full, 1, 100) || Check(invalid, 1, -1);
    }
}
