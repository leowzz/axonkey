use std::cell::RefCell;
use windows::{
    core::w,
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{
            BeginPaint, CreateFontW, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW,
            EndPaint, FillRect, GetMonitorInfoW, MonitorFromPoint, SelectObject, SetBkMode,
            SetTextColor, ANTIALIASED_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
            DT_END_ELLIPSIS, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FW_MEDIUM, FW_NORMAL,
            FW_SEMIBOLD, HDC, MONITORINFO, MONITOR_DEFAULTTOPRIMARY, OUT_DEFAULT_PRECIS,
            PAINTSTRUCT,
        },
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, GetClientRect, GetCursorPos, LoadCursorW,
                RegisterClassW, SetLayeredWindowAttributes, SetWindowPos, ShowWindow,
                HTTRANSPARENT, HWND_TOPMOST, IDC_ARROW, LWA_ALPHA, SWP_NOACTIVATE, SWP_NOSIZE,
                SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, WM_ERASEBKGND, WM_NCHITTEST, WM_PAINT,
                WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
                WS_POPUP,
            },
        },
    },
};

const WIDTH: i32 = 420;
const HEIGHT: i32 = 100;
const CLASS_NAME: windows::core::PCWSTR = w!("AxonkeyProfileSwitchOverlay");

thread_local! {
    static WINDOW: RefCell<Option<NativeOverlay>> = const { RefCell::new(None) };
    static PAINT_TEXT: RefCell<(Vec<u16>, Vec<u16>, Vec<u16>)> = const { RefCell::new((Vec::new(), Vec::new(), Vec::new())) };
}

pub(super) fn show_profile_switch_overlay(
    device: &str,
    from: &str,
    to: &str,
    revision: u64,
) -> windows::core::Result<()> {
    WINDOW.with(|slot| -> windows::core::Result<()> {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = Some(NativeOverlay::create()?);
        }
        let window = slot.as_mut().unwrap();
        window.from = utf16(from);
        window.to = utf16(to);
        window.revision = revision;
        PAINT_TEXT.with(|text| {
            *text.borrow_mut() = (
                utf16(&format!("{device} · 配置已切换")),
                window.from.clone(),
                window.to.clone(),
            )
        });
        window.show()
    })
}

pub(super) fn hide_profile_switch_overlay(revision: u64) {
    WINDOW.with(|slot| {
        if let Some(window) = slot.borrow().as_ref() {
            if window.revision == revision {
                window.hide();
            }
        }
    });
}

struct NativeOverlay {
    hwnd: HWND,
    from: Vec<u16>,
    to: Vec<u16>,
    revision: u64,
}

impl NativeOverlay {
    fn create() -> windows::core::Result<Self> {
        unsafe {
            let module = GetModuleHandleW(None)?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: module.into(),
                hCursor: LoadCursorW(None, IDC_ARROW)?,
                lpszClassName: CLASS_NAME,
                ..Default::default()
            };
            RegisterClassW(&class);
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                CLASS_NAME,
                w!("配置已切换 · Axonkey"),
                WS_POPUP,
                0,
                0,
                WIDTH,
                HEIGHT,
                None,
                None,
                Some(module.into()),
                None,
            )?;
            SetLayeredWindowAttributes(hwnd, COLORREF(0), 238, LWA_ALPHA)?;
            Ok(Self {
                hwnd,
                from: Vec::new(),
                to: Vec::new(),
                revision: 0,
            })
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
            SetWindowPos(
                self.hwnd,
                None,
                info.rcWork.left,
                info.rcWork.top,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOSIZE | SWP_SHOWWINDOW,
            )?;
            let rect = placement(info.rcWork, GetDpiForWindow(self.hwnd));
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, 32, 32);
            if windows::Win32::Graphics::Gdi::SetWindowRgn(self.hwnd, Some(region), false) == 0 {
                let _ = DeleteObject(region.into());
            }
            SetWindowPos(
                self.hwnd,
                Some(HWND_TOPMOST),
                rect.left,
                rect.top,
                width,
                height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )?;
            let _ = windows::Win32::Graphics::Gdi::InvalidateRect(Some(self.hwnd), None, false);
            let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
            Ok(())
        }
    }

    fn hide(&self) {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
        }
    }
}

impl Drop for NativeOverlay {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(self.hwnd);
        }
    }
}

fn utf16(value: &str) -> Vec<u16> {
    // DrawTextW takes the slice length, so a trailing NUL would count as text.
    value.encode_utf16().collect()
}

fn placement(work: RECT, dpi: u32) -> RECT {
    let width = WIDTH * dpi as i32 / 96;
    let height = HEIGHT * dpi as i32 / 96;
    let left = work.left + (work.right - work.left) / 2 - width / 2;
    let top = work.top + (work.bottom - work.top) * 3 / 4 - height / 2;
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
    _wparam: WPARAM,
    _lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            PAINT_TEXT.with(|text| {
                let text = text.borrow();
                draw(dc, rect, &text.0, &text.1, &text.2);
            });
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        _ => DefWindowProcW(hwnd, message, _wparam, _lparam),
    }
}

unsafe fn draw(dc: HDC, rect: RECT, title: &[u16], from: &[u16], to: &[u16]) {
    let scale = |value: i32| value * (rect.bottom - rect.top) / HEIGHT;
    let background = CreateSolidBrush(COLORREF(0x00261d18));
    FillRect(dc, &rect, background);
    let _ = DeleteObject(background.into());
    SetBkMode(dc, windows::Win32::Graphics::Gdi::TRANSPARENT);
    SetTextColor(dc, COLORREF(0x00d4e2ff));
    let title_font = CreateFontW(
        -scale(12),
        0,
        0,
        0,
        FW_MEDIUM.0 as i32,
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
    let old_title = SelectObject(dc, title_font.into());
    let mut title = title.to_vec();
    let mut title_rect = RECT {
        left: scale(64),
        top: scale(17),
        right: rect.right - scale(20),
        bottom: scale(39),
    };
    DrawTextW(
        dc,
        &mut title,
        &mut title_rect,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
    );
    SelectObject(dc, old_title);
    let _ = DeleteObject(title_font.into());

    SetTextColor(dc, COLORREF(0x00f8f8f8));
    let value_font = CreateFontW(
        -scale(17),
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
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
    let old_value = SelectObject(dc, value_font.into());
    let mut from_rect = RECT {
        left: scale(64),
        top: scale(48),
        right: scale(205),
        bottom: scale(78),
    };
    DrawTextW(
        dc,
        &mut from.to_vec(),
        &mut from_rect,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
    );
    let mut arrow = utf16("→");
    let mut arrow_rect = RECT {
        left: scale(215),
        top: scale(48),
        right: scale(239),
        bottom: scale(78),
    };
    DrawTextW(
        dc,
        &mut arrow,
        &mut arrow_rect,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
    );
    let value_font_bold = CreateFontW(
        -scale(17),
        0,
        0,
        0,
        FW_SEMIBOLD.0 as i32,
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
    SelectObject(dc, value_font_bold.into());
    let mut to_rect = RECT {
        left: scale(250),
        top: scale(48),
        right: rect.right - scale(20),
        bottom: scale(78),
    };
    DrawTextW(
        dc,
        &mut to.to_vec(),
        &mut to_rect,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
    );
    SelectObject(dc, old_value);
    let _ = DeleteObject(value_font.into());
    let _ = DeleteObject(value_font_bold.into());
}
