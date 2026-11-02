#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

// Opt-in, one-shot diagnostic metadata. All recording/sealing is on the BLE
// delegate queue; only the sealed buffer is handed to the file writer.
#define AK_AUDIO_TRACE_CAPACITY 8192
typedef struct {
    double unixTime, uptime;
    NSUInteger length;
    uint32_t session, flags;
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
} AKAudioTraceEntry;

@interface AKAudioPacketTrace : NSObject
@property(nonatomic, readonly) BOOL started;
@property(nonatomic, readonly) BOOL sealed;
@property(nonatomic, readonly) NSUInteger count;
- (instancetype)initWithPath:(NSString *)path;
- (void)recordData:(NSData *)data uptime:(double)uptime unixTime:(double)unixTime
           session:(uint32_t)session flags:(uint32_t)flags;
- (void)seal;
- (BOOL)writeCSV;
@end

@implementation AKAudioPacketTrace {
    NSString *_path;
    AKAudioTraceEntry *_entries;
    NSUInteger _dropped;
}
- (instancetype)initWithPath:(NSString *)path {
    if (!path.isAbsolutePath) return nil;
    self = [super init];
    if (self) {
        _path = [path copy];
        _entries = calloc(AK_AUDIO_TRACE_CAPACITY, sizeof(AKAudioTraceEntry));
        if (_entries == NULL) return nil;
    }
    return self;
}
- (void)dealloc { free(_entries); }
- (void)recordData:(NSData *)data uptime:(double)uptime unixTime:(double)unixTime
           session:(uint32_t)session flags:(uint32_t)flags {
    if (_sealed) return;
    _started = YES;
    if (_count == AK_AUDIO_TRACE_CAPACITY) { _dropped++; return; }
    AKAudioTraceEntry *entry = &_entries[_count++];
    entry->unixTime = unixTime;
    entry->uptime = uptime;
    entry->length = data.length;
    entry->session = session;
    entry->flags = flags;
    CC_SHA256(data.bytes, (CC_LONG)data.length, entry->digest);
}
- (void)seal { _sealed = YES; }
- (BOOL)writeCSV {
    if (!_sealed || !_started) return NO;
    NSMutableString *csv = [NSMutableString stringWithFormat:
        @"# axonkey_audio_trace_v1 capacity=%d dropped=%lu\n"
         "# flags: 1=stale_peripheral 2=read_error 4=missing_value\n"
         "index,unix_seconds,uptime_seconds,session_id,flags,bytes,sha256\n",
        AK_AUDIO_TRACE_CAPACITY, (unsigned long)_dropped];
    static const char hex[] = "0123456789abcdef";
    for (NSUInteger i = 0; i < _count; i++) {
        const AKAudioTraceEntry *entry = &_entries[i];
        char digest[CC_SHA256_DIGEST_LENGTH * 2 + 1];
        for (size_t j = 0; j < CC_SHA256_DIGEST_LENGTH; j++) {
            digest[j * 2] = hex[entry->digest[j] >> 4];
            digest[j * 2 + 1] = hex[entry->digest[j] & 15];
        }
        digest[sizeof(digest) - 1] = 0;
        [csv appendFormat:@"%lu,%.6f,%.9f,%u,%u,%lu,%s\n",
            (unsigned long)i, entry->unixTime, entry->uptime, entry->session,
            entry->flags, (unsigned long)entry->length, digest];
    }
    NSData *data = [csv dataUsingEncoding:NSUTF8StringEncoding];
    // Never follow/overwrite an existing destination; permissions are private
    // from creation, rather than corrected after potentially sensitive output.
    int fd = open(_path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) return NO;
    const uint8_t *bytes = data.bytes;
    size_t remaining = data.length;
    while (remaining > 0) {
        ssize_t n = write(fd, bytes, remaining);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { close(fd); return NO; }
        bytes += n;
        remaining -= (size_t)n;
    }
    return close(fd) == 0;
}
@end
