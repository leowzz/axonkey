#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

bool axonkey_macos_rasterize_1bpp_line(
    const char *utf8_text,
    uint32_t width,
    uint32_t height,
    uint8_t *out_1bpp
) {
    if (utf8_text == NULL || out_1bpp == NULL || width == 0 || height == 0 || (width % 8) != 0) {
        return false;
    }
    size_t stride = width / 8;
    memset(out_1bpp, 0, stride * (size_t)height);
    if (utf8_text[0] == '\0') {
        return true;
    }

    @autoreleasepool {
        NSString *text = [NSString stringWithUTF8String:utf8_text];
        if (text == nil || text.length == 0) {
            return true;
        }

        uint8_t *gray = (uint8_t *)calloc((size_t)width * (size_t)height, 1);
        if (gray == NULL) {
            return false;
        }

        CGColorSpaceRef space = CGColorSpaceCreateDeviceGray();
        CGContextRef ctx = space != NULL
            ? CGBitmapContextCreate(gray, width, height, 8, width, space, kCGImageAlphaNone)
            : NULL;
        if (ctx == NULL) {
            if (space != NULL) CFRelease(space);
            free(gray);
            return false;
        }

        CGFloat font_size = height >= 16 ? 12.0 : (CGFloat)(height > 4 ? height - 3 : height);
        CTFontRef font = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, font_size, CFSTR("zh-Hans"));
        if (font == NULL) {
            font = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, font_size, NULL);
        }
        CGFloat white_components[2] = {1.0, 1.0};
        CGColorRef white = CGColorCreate(space, white_components);
        if (font != NULL && white != NULL) {
            NSDictionary *attrs = @{
                (__bridge NSString *)kCTFontAttributeName: (__bridge id)font,
                (__bridge NSString *)kCTForegroundColorAttributeName: (__bridge id)white,
            };
            NSAttributedString *attributed = [[NSAttributedString alloc] initWithString:text attributes:attrs];
            CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)attributed);
            if (line != NULL) {
                CGFloat ascent = 0;
                CGFloat descent = 0;
                double advance = CTLineGetTypographicBounds(line, &ascent, &descent, NULL);
                double max_width = width > 4 ? (double)(width - 4) : (double)width;
                if (advance > max_width && max_width > 8.0) {
                    NSAttributedString *ellipsis_attr =
                        [[NSAttributedString alloc] initWithString:@"…" attributes:attrs];
                    CTLineRef ellipsis =
                        CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)ellipsis_attr);
                    if (ellipsis != NULL) {
                        CTLineRef truncated =
                            CTLineCreateTruncatedLine(line, max_width, kCTLineTruncationEnd, ellipsis);
                        CFRelease(ellipsis);
                        if (truncated != NULL) {
                            CFRelease(line);
                            line = truncated;
                        }
                    }
                }

                CGFloat baseline = floor(((CGFloat)height - (ascent + descent)) * 0.5 + descent + 0.5);
                if (baseline < 1.0) baseline = 1.0;
                CGContextSetShouldAntialias(ctx, true);
                CGContextSetShouldSmoothFonts(ctx, false);
                CGContextSetAllowsFontSubpixelPositioning(ctx, false);
                CGContextSetTextMatrix(ctx, CGAffineTransformIdentity);
                CGContextSetTextPosition(ctx, 2.0, baseline);
                CTLineDraw(line, ctx);
                CFRelease(line);
            }
        }

        for (uint32_t y = 0; y < height; y++) {
            const uint8_t *src_row = gray + (size_t)y * width;
            uint8_t *dst_row = out_1bpp + (size_t)y * stride;
            for (uint32_t x = 0; x < width; x++) {
                if (src_row[x] >= 100) {
                    dst_row[x >> 3] |= (uint8_t)(0x80u >> (x & 7));
                }
            }
        }

        if (white != NULL) CFRelease(white);
        if (font != NULL) CFRelease(font);
        CGContextRelease(ctx);
        CGColorSpaceRelease(space);
        free(gray);
        return true;
    }
}
