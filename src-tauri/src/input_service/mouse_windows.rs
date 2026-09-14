use super::{screen_edge, ScrollAccumulator, Shared};
use crate::input_service::NativeBehavior;
use std::{
    cell::RefCell,
    ffi::c_void,
    sync::{atomic::Ordering, Arc},
    thread,
    time::Duration,
};

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: i32,
    y: i32,
}
#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
struct MonitorInfo {
    size: u32,
    monitor: Rect,
    work: Rect,
    flags: u32,
}
#[repr(C)]
struct MouseHook {
    point: Point,
    mouse_data: u32,
    flags: u32,
    time: u32,
    extra_info: usize,
}
#[repr(C)]
#[derive(Default)]
struct Message {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    point: Point,
    private: u32,
}

thread_local! {
    static CAPTURE: RefCell<Option<(Arc<Shared>, ScrollAccumulator)>> = const { RefCell::new(None) };
}

fn wheel_direction(message: usize, delta: i32, flags: u32) -> Option<usize> {
    if flags & 0x03 != 0 || delta == 0 {
        return None;
    }
    match message {
        0x020A => Some(if delta > 0 { 0 } else { 1 }),
        0x020E => Some(if delta > 0 { 3 } else { 2 }),
        _ => None,
    }
}

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(
        kind: i32,
        callback: unsafe extern "system" fn(i32, usize, isize) -> isize,
        module: *mut c_void,
        thread: u32,
    ) -> isize;
    fn UnhookWindowsHookEx(hook: isize) -> i32;
    fn CallNextHookEx(hook: isize, code: i32, wparam: usize, lparam: isize) -> isize;
    fn PeekMessageW(message: *mut Message, hwnd: isize, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(message: *const Message) -> i32;
    fn DispatchMessageW(message: *const Message) -> isize;
    fn MonitorFromPoint(point: Point, flags: u32) -> isize;
    fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
}

unsafe extern "system" fn callback(code: i32, wparam: usize, lparam: isize) -> isize {
    let consumed = std::panic::catch_unwind(|| {
        if code < 0 || lparam == 0 || !matches!(wparam, 0x0200 | 0x020A | 0x020E) {
            return false;
        }
        let event = &*(lparam as *const MouseHook);
        // Includes this application's SendInput output and other synthetic input.
        if event.flags & 0x03 != 0 {
            return false;
        }
        CAPTURE.with(|capture| {
            let mut capture = capture.borrow_mut();
            let Some((shared, scroll)) = capture.as_mut() else {
                return false;
            };
            if !shared.active.load(Ordering::Acquire) {
                scroll.reset();
                return false;
            }
            let monitor = MonitorFromPoint(event.point, 0);
            let mut info = MonitorInfo {
                size: std::mem::size_of::<MonitorInfo>() as u32,
                monitor: Rect::default(),
                work: Rect::default(),
                flags: 0,
            };
            if monitor == 0 || GetMonitorInfoW(monitor, &mut info) == 0 {
                scroll.reset();
                return false;
            }
            let Some(edge) = screen_edge(
                event.point.x as f64,
                event.point.y as f64,
                info.monitor.left as f64,
                info.monitor.top as f64,
                info.monitor.right as f64,
                info.monitor.bottom as f64,
            ) else {
                scroll.reset();
                return false;
            };
            scroll.enter(edge);
            if wparam == 0x0200 {
                return false;
            }
            let delta = (event.mouse_data >> 16) as i16 as i32;
            let Some(direction) = wheel_direction(wparam, delta, event.flags) else {
                return false;
            };
            let Some(input) = edge.input(direction) else {
                scroll.reset();
                return false;
            };
            scroll.scroll(shared, input, delta.unsigned_abs() as f64 / 120.0)
        })
    })
    .unwrap_or(false);
    if consumed {
        1
    } else {
        CallNextHookEx(0, code, wparam, lparam)
    }
}

pub(super) fn run(shared: Arc<Shared>) {
    CAPTURE.with(|capture| {
        *capture.borrow_mut() = Some((Arc::clone(&shared), ScrollAccumulator::default()))
    });
    let hook = unsafe { SetWindowsHookExW(14, callback, GetModuleHandleW(std::ptr::null()), 0) };
    if hook == 0 {
        log::error!(
            "Cannot install mouse hook: {}",
            std::io::Error::last_os_error()
        );
        CAPTURE.with(|capture| *capture.borrow_mut() = None);
        return;
    }
    shared.ready.store(true, Ordering::Release);
    while !shared.stop.load(Ordering::Acquire) {
        let mut message = Message::default();
        unsafe {
            while PeekMessageW(&mut message, 0, 0, 0, 1) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    shared.ready.store(false, Ordering::Release);
    unsafe {
        UnhookWindowsHookEx(hook);
    }
    CAPTURE.with(|capture| *capture.borrow_mut() = None);
}

pub(super) fn execute(behavior: &NativeBehavior) {
    super::super::windows::execute_mouse_behavior(behavior);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_wheel_axes_have_distinct_signs_and_never_reconsume_injected_events() {
        assert_eq!(wheel_direction(0x020A, 120, 0), Some(0));
        assert_eq!(wheel_direction(0x020A, -120, 0), Some(1));
        assert_eq!(wheel_direction(0x020E, -120, 0), Some(2));
        assert_eq!(wheel_direction(0x020E, 120, 0), Some(3));
        for flag in [1, 2, 3] {
            assert_eq!(wheel_direction(0x020A, 120, flag), None);
        }
        assert_eq!(wheel_direction(0x020A, 0, 0), None);
        assert_eq!(wheel_direction(0x0200, 120, 0), None);
    }
}
