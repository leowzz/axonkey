//! Win32 rendering for the shared recording indicator.
use super::{HEIGHT, ON_CLICK, WIDTH};
use std::cell::RefCell;
use windows::{
    core::w,
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM},
        Graphics::Gdi::*,
        System::LibraryLoader::GetModuleHandleW,
        UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::*},
    },
};

thread_local! {
    // Created, painted and destroyed on Tauri's existing UI thread.
    static WINDOW: RefCell<Option<NativeOverlay>> = const { RefCell::new(None) };
    static ICON: RefCell<Option<AppIcon>> = const { RefCell::new(None) };
}

pub(super) fn refresh_window(visible: bool) {
    let result = WINDOW.with(|slot| -> windows::core::Result<()> {
        let mut slot = slot.borrow_mut();
        if visible {
            if slot.is_none() {
                *slot = Some(NativeOverlay::create()?);
            }
            slot.as_ref().unwrap().show()?;
        } else if let Some(window) = slot.as_ref() {
            window.hide();
        }
        Ok(())
    });
    if let Err(error) = result {
        log::warn!(target: "axonkey::recording", "Cannot update recording indicator: {error}");
    }
}

struct NativeOverlay(HWND);

struct AppIcon(HICON);

impl AppIcon {
    unsafe fn create() -> windows::core::Result<Self> {
        let image = tauri::include_image!("./icons/32x32.png");
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: image.width() as i32,
                biHeight: -(image.height() as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let color = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), image.rgba().len());
        for (source, target) in image.rgba().chunks_exact(4).zip(pixels.chunks_exact_mut(4)) {
            let alpha = source[3] as u16;
            target.copy_from_slice(&[
                (source[2] as u16 * alpha / 255) as u8,
                (source[1] as u16 * alpha / 255) as u8,
                (source[0] as u16 * alpha / 255) as u8,
                source[3],
            ]);
        }
        let mask = CreateBitmap(image.width() as i32, image.height() as i32, 1, 1, None);
        let icon = CreateIconIndirect(&ICONINFO {
            fIcon: true.into(),
            hbmColor: color,
            hbmMask: mask,
            ..Default::default()
        });
        let _ = DeleteObject(color.into());
        let _ = DeleteObject(mask.into());
        icon.map(Self)
    }
}

impl Drop for AppIcon {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyIcon(self.0);
        }
    }
}

impl NativeOverlay {
    fn create() -> windows::core::Result<Self> {
        unsafe {
            let module = GetModuleHandleW(None)?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: module.into(),
                hCursor: LoadCursorW(None, IDC_HAND)?,
                lpszClassName: w!("AxonkeyRecordingIndicator"),
                ..Default::default()
            };
            RegisterClassW(&class);
            let window = Self(CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class.lpszClassName,
                w!("正在录音 · Axonkey"),
                WS_POPUP,
                0,
                0,
                WIDTH,
                HEIGHT,
                None,
                None,
                Some(module.into()),
                None,
            )?);
            SetLayeredWindowAttributes(window.0, COLORREF(0), 224, LWA_ALPHA)?;
            Ok(window)
        }
    }

    fn show(&self) -> windows::core::Result<()> {
        unsafe {
            let mut cursor = POINT::default();
            let _ = GetCursorPos(&mut cursor);
            let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            GetMonitorInfoW(monitor, &mut info).ok()?;
            // Move onto the target monitor before reading the per-window DPI.
            SetWindowPos(
                self.0,
                None,
                info.rcWork.left,
                info.rcWork.top,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
            )?;
            let rect = placement(info.rcWork, GetDpiForWindow(self.0));
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, height, height);
            if SetWindowRgn(self.0, Some(region), false) == 0 {
                let _ = DeleteObject(region.into());
            }
            SetWindowPos(
                self.0,
                Some(HWND_TOPMOST),
                rect.left,
                rect.top,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )?;
            let _ = InvalidateRect(Some(self.0), None, false);
            Ok(())
        }
    }

    fn hide(&self) {
        unsafe {
            let _ = ShowWindow(self.0, SW_HIDE);
        }
    }
}

impl Drop for NativeOverlay {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}

fn placement(work: RECT, dpi: u32) -> RECT {
    let width = WIDTH * dpi as i32 / 96;
    let height = HEIGHT * dpi as i32 / 96;
    let left = work.left + (work.right - work.left) * 2 / 5 - width / 2;
    let top = work.top + (work.bottom - work.top) * 4 / 5 - height / 2;
    RECT {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            draw(dc, rect);
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_NCHITTEST => LRESULT(HTCLIENT as isize),
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_LBUTTONUP => {
            if let Some(on_click) = ON_CLICK.get() {
                on_click();
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

unsafe fn draw(dc: HDC, rect: RECT) {
    let scale = |value: i32| value * (rect.bottom - rect.top) / HEIGHT;
    let background = CreateSolidBrush(COLORREF(0x00372e27));
    FillRect(dc, &rect, background);
    let _ = DeleteObject(background.into());
    let font = CreateFontW(
        -scale(13),
        0,
        0,
        0,
        500,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        ANTIALIASED_QUALITY,
        0,
        w!("Microsoft YaHei UI"),
    );
    let old_font = SelectObject(dc, font.into());
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, COLORREF(0x00faf6f1));
    let mut text: Vec<u16> = "正在录音".encode_utf16().collect();
    let mut size = SIZE::default();
    let _ = GetTextExtentPoint32W(dc, &text, &mut size);
    let content_left = (rect.right - size.cx - scale(46)) / 2;
    ICON.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            match AppIcon::create() {
                Ok(icon) => *slot = Some(icon),
                Err(error) => {
                    log::warn!(target: "axonkey::recording", "Cannot load app icon: {error}")
                }
            }
        }
        if let Some(icon) = slot.as_ref() {
            let _ = DrawIconEx(
                dc,
                content_left,
                scale(8),
                icon.0,
                scale(20),
                scale(20),
                0,
                None,
                DI_NORMAL,
            );
        }
    });
    let dot = CreateSolidBrush(COLORREF(0x007171f8));
    let old_brush = SelectObject(dc, dot.into());
    let old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
    let _ = Ellipse(
        dc,
        content_left + scale(28),
        scale(14),
        content_left + scale(36),
        scale(22),
    );
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    let _ = DeleteObject(dot.into());
    let mut text_rect = RECT {
        left: content_left + scale(46),
        ..rect
    };
    DrawTextW(
        dc,
        &mut text,
        &mut text_rect,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );
    SelectObject(dc, old_font);
    let _ = DeleteObject(font.into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn placement_scales_on_monitors_with_negative_origins() {
        let work = RECT {
            left: -2560,
            top: -200,
            right: 0,
            bottom: 1200,
        };
        let rect = placement(work, 144);
        assert_eq!(rect.right - rect.left, WIDTH * 3 / 2);
        assert_eq!(rect.bottom - rect.top, HEIGHT * 3 / 2);
        assert_eq!((rect.left + rect.right) / 2, -1536);
        assert_eq!((rect.top + rect.bottom) / 2, 920);
    }

    #[test]
    fn native_window_is_translucent_clickable_and_does_not_take_focus() {
        unsafe {
            static CLICKS: AtomicU64 = AtomicU64::new(0);
            ON_CLICK
                .set(|| {
                    CLICKS.fetch_add(1, Ordering::Relaxed);
                })
                .unwrap();
            let foreground = GetForegroundWindow();
            let window = NativeOverlay::create().unwrap();
            window.show().unwrap();
            let style = GetWindowLongW(window.0, GWL_EXSTYLE) as u32;
            for required in [
                WS_EX_LAYERED,
                WS_EX_NOACTIVATE,
                WS_EX_TOOLWINDOW,
                WS_EX_TOPMOST,
            ] {
                assert_ne!(style & required.0, 0);
            }
            assert_eq!(style & WS_EX_TRANSPARENT.0, 0);
            assert_eq!(
                window_proc(window.0, WM_NCHITTEST, WPARAM(0), LPARAM(0)).0,
                HTCLIENT as isize
            );
            assert_eq!(
                window_proc(window.0, WM_MOUSEACTIVATE, WPARAM(0), LPARAM(0)).0,
                MA_NOACTIVATE as isize
            );
            assert_eq!(
                window_proc(window.0, WM_LBUTTONUP, WPARAM(0), LPARAM(0)).0,
                0
            );
            assert_eq!(CLICKS.load(Ordering::Relaxed), 1);
            assert_eq!(GetForegroundWindow(), foreground);
            assert!(IsWindowVisible(window.0).as_bool());
            let mut alpha = 0;
            GetLayeredWindowAttributes(window.0, None, Some(&mut alpha), None).unwrap();
            assert_eq!(alpha, 224);
            window.hide();
            assert!(!IsWindowVisible(window.0).as_bool());
        }
    }

    #[test]
    fn native_paint_renders_text_and_indicator_at_multiple_dpi() {
        for dpi in [96, 144, 192] {
            unsafe {
                let width = WIDTH * dpi / 96;
                let height = HEIGHT * dpi / 96;
                let rect = RECT {
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: height,
                };
                let dc = CreateCompatibleDC(None);
                let info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width,
                        biHeight: -height,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut bits = std::ptr::null_mut();
                let bitmap =
                    CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).unwrap();
                let old = SelectObject(dc, bitmap.into());
                let paper = CreateSolidBrush(COLORREF(0x00fcfaf8));
                FillRect(dc, &rect, paper);
                let _ = DeleteObject(paper.into());
                let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, height, height);
                SelectClipRgn(dc, Some(region));
                draw(dc, rect);
                ICON.with(|icon| {
                    assert!(icon.borrow().is_some(), "the application icon must load")
                });
                let _ = GdiFlush();
                let pixels =
                    std::slice::from_raw_parts(bits.cast::<u8>(), (width * height * 4) as usize);
                let content = pixels
                    .chunks_exact(4)
                    .skip((width * height / 3) as usize)
                    .take((width * height / 3) as usize);
                assert!(content
                    .clone()
                    .any(|p| p[0] > 200 && p[1] > 200 && p[2] > 200));
                assert!(content
                    .clone()
                    .any(|p| p[2] > 200 && p[1] < 160 && p[0] < 160));
                if let Ok(directory) = std::env::var("AXONKEY_RECORDING_PREVIEW") {
                    let mut bmp = Vec::from(*b"BM");
                    bmp.extend_from_slice(&(54 + pixels.len() as u32).to_le_bytes());
                    bmp.extend_from_slice(&[0; 4]);
                    bmp.extend_from_slice(&54u32.to_le_bytes());
                    bmp.extend_from_slice(&40u32.to_le_bytes());
                    bmp.extend_from_slice(&width.to_le_bytes());
                    bmp.extend_from_slice(&(-height).to_le_bytes());
                    bmp.extend_from_slice(&1u16.to_le_bytes());
                    bmp.extend_from_slice(&32u16.to_le_bytes());
                    bmp.extend_from_slice(&[0; 24]);
                    bmp.extend_from_slice(pixels);
                    std::fs::write(
                        std::path::Path::new(&directory).join(format!("recording-{dpi}.bmp")),
                        bmp,
                    )
                    .unwrap();
                }
                SelectClipRgn(dc, None);
                let _ = DeleteObject(region.into());
                SelectObject(dc, old);
                let _ = DeleteObject(bitmap.into());
                let _ = DeleteDC(dc);
            }
        }
    }
}
