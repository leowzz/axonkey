#import <Foundation/Foundation.h>
#include <sys/stat.h>
#import "../src-tauri/native/macos_audio_trace.h"

int main(void) {
    @autoreleasepool {
        NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:
            NSUUID.UUID.UUIDString];
        assert([NSFileManager.defaultManager createDirectoryAtPath:dir
            withIntermediateDirectories:NO attributes:nil error:nil]);
        NSString *path = [dir stringByAppendingPathComponent:@"trace.csv"];
        assert([[AKAudioPacketTrace alloc] initWithPath:@"relative.csv"] == nil);
        AKAudioPacketTrace *trace = [[AKAudioPacketTrace alloc] initWithPath:path];
        assert(!trace.started && !trace.sealed);
        assert(![trace writeCSV]);
        NSData *payload = [@"abc" dataUsingEncoding:NSUTF8StringEncoding];
        for (NSUInteger i = 0; i < AK_AUDIO_TRACE_CAPACITY + 1; i++) {
            [trace recordData:payload uptime:100 + i * .015
                unixTime:1700000000 + i * .015 session:3 flags:0];
        }
        assert(trace.count == AK_AUDIO_TRACE_CAPACITY);
        assert(![NSFileManager.defaultManager fileExistsAtPath:path]);
        [trace seal];
        [trace recordData:payload uptime:999 unixTime:999 session:4 flags:7];
        assert(trace.count == AK_AUDIO_TRACE_CAPACITY);
        assert([trace writeCSV]);
        NSString *csv = [NSString stringWithContentsOfFile:path
            encoding:NSUTF8StringEncoding error:nil];
        assert([csv containsString:@"dropped=1"]);
        assert([csv containsString:@"0,1700000000.000000,100.000000000,3,0,3,ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"]);
        assert(![trace writeCSV]); // Existing files are never overwritten.
        struct stat st;
        assert(stat(path.fileSystemRepresentation, &st) == 0);
        assert((st.st_mode & 0777) == 0600);
        assert([NSFileManager.defaultManager removeItemAtPath:dir error:nil]);
    }
    return 0;
}
