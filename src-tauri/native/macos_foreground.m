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

int axonkey_application_icon(const char *app_id, const char *path, char *output, size_t capacity) {
    if (!output || capacity == 0) return -1;
    @autoreleasepool {
        NSString *resolvedPath = nil;
        if (path && path[0]) {
            NSString *candidate = [NSString stringWithUTF8String:path];
            if (candidate.length && [NSFileManager.defaultManager fileExistsAtPath:candidate]) {
                resolvedPath = candidate;
            }
        }
        if (!resolvedPath && app_id && strncmp(app_id, "macos:", 6) == 0) {
            NSString *identity = [NSString stringWithUTF8String:app_id + 6];
            if ([identity hasPrefix:@"/"]) {
                if ([NSFileManager.defaultManager fileExistsAtPath:identity]) {
                    resolvedPath = identity;
                }
            } else if (identity.length) {
                NSURL *url = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:identity];
                if (url.path.length && [NSFileManager.defaultManager fileExistsAtPath:url.path]) {
                    resolvedPath = url.path;
                }
            }
        }
        if (!resolvedPath) return 0;
        NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:resolvedPath];
        if (!icon) return 0;
        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
            initWithBitmapDataPlanes:NULL
                          pixelsWide:32
                          pixelsHigh:32
                       bitsPerSample:8
                     samplesPerPixel:4
                            hasAlpha:YES
                            isPlanar:NO
                      colorSpaceName:NSDeviceRGBColorSpace
                         bytesPerRow:0
                        bitsPerPixel:0];
        if (!rep || !rep.bitmapData) return 0;
        memset(rep.bitmapData, 0, (size_t)rep.bytesPerRow * 32);
        rep.size = NSMakeSize(32, 32);
        [NSGraphicsContext saveGraphicsState];
        NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
        if (!context) {
            [NSGraphicsContext restoreGraphicsState];
            return 0;
        }
        [NSGraphicsContext setCurrentContext:context];
        context.imageInterpolation = NSImageInterpolationHigh;
        [icon drawInRect:NSMakeRect(0, 0, 32, 32)
                fromRect:NSZeroRect
               operation:NSCompositingOperationSourceOver
                fraction:1.0];
        [NSGraphicsContext restoreGraphicsState];
        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png.length) return 0;
        NSString *dataUrl = [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
        NSData *utf8 = [dataUrl dataUsingEncoding:NSUTF8StringEncoding];
        if (!utf8 || utf8.length + 1 > capacity) return -1;
        memcpy(output, utf8.bytes, utf8.length);
        output[utf8.length] = 0;
        return 1;
    }
}
