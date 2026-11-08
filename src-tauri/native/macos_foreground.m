#import <AppKit/AppKit.h>

int axonkey_foreground_application(const char *path, char *output, size_t capacity) {
    @autoreleasepool {
        NSRunningApplication *running = path ? nil : NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!path && !running) return 0;
        NSURL *url = path ? [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]] : running.bundleURL;
        if (!url || ![url.pathExtension.lowercaseString isEqualToString:@"app"]) return path ? -1 : 0;
        NSBundle *bundle = path ? [NSBundle bundleWithURL:url] : nil;
        if (path && (!bundle || ![NSFileManager.defaultManager fileExistsAtPath:url.path])) return -1;
        NSString *identifier = running.bundleIdentifier ?: bundle.bundleIdentifier;
        NSString *name = running.localizedName ?: [bundle objectForInfoDictionaryKey:@"CFBundleDisplayName"]
            ?: [bundle objectForInfoDictionaryKey:@"CFBundleName"] ?: url.lastPathComponent.stringByDeletingPathExtension;
        NSString *identity = identifier.length ? identifier : url.path;
        NSDictionary *app = @{ @"id": [@"macos:" stringByAppendingString:identity], @"name": name, @"path": url.path };
        NSData *json = [NSJSONSerialization dataWithJSONObject:app options:0 error:nil];
        if (!json || json.length + 1 > capacity) return -1;
        memcpy(output, json.bytes, json.length);
        output[json.length] = 0;
        return 1;
    }
}
