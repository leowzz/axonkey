use super::{screen_edge, ButtonTracker, ScrollAccumulator, Shared};
use crate::input_service::NativeBehavior;
use std::{
    ffi::c_void,
    sync::{atomic::Ordering, Arc},
    thread,
    time::{Duration, Instant},
};

struct Capture {
    shared: Arc<Shared>,
    scroll: ScrollAccumulator,
    buttons: ButtonTracker,
}
extern "C" {
    fn axonkey_macos_mouse_run(
        context: *mut c_void,
        stop: unsafe extern "C" fn(*mut c_void) -> bool,
        ready: unsafe extern "C" fn(*mut c_void, bool),
        scroll: unsafe extern "C" fn(*mut c_void, f64, f64, f64, f64, f64, f64, f64, f64) -> bool,
        button: unsafe extern "C" fn(*mut c_void, i32, bool, f64, f64, f64, f64, f64, f64) -> bool,
    ) -> bool;
}
unsafe extern "C" fn stop(context: *mut c_void) -> bool {
    let capture = &mut *(context as *mut Capture);
    capture.buttons.tick(&capture.shared, Instant::now());
    capture.shared.stop.load(Ordering::Acquire)
}
unsafe extern "C" fn ready(context: *mut c_void, value: bool) {
    (*(context as *mut Capture))
        .shared
        .ready
        .store(value, Ordering::Release);
}
unsafe extern "C" fn scroll(
    context: *mut c_void,
    x: f64,
    y: f64,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    vertical: f64,
    horizontal: f64,
) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let capture = &mut *(context as *mut Capture);
        if !capture.shared.active.load(Ordering::Acquire) {
            capture.scroll.reset();
            return false;
        }
        let edge = screen_edge(x, y, left, top, right, bottom);
        capture.scroll.enter(edge);
        // A diagonal gesture selects its dominant axis, so one event never runs
        // two unrelated mappings. Quartz positive values mean up / left.
        let (direction, amount) = if horizontal.abs() > vertical.abs() {
            (if horizontal > 0.0 { 2 } else { 3 }, horizontal.abs())
        } else {
            (if vertical > 0.0 { 0 } else { 1 }, vertical.abs())
        };
        capture.scroll.scroll(&capture.shared, direction, amount)
    }))
    .unwrap_or(false)
}
unsafe extern "C" fn button(
    context: *mut c_void,
    index: i32,
    down: bool,
    x: f64,
    y: f64,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let capture = &mut *(context as *mut Capture);
        capture.buttons.event(
            &capture.shared,
            index as usize,
            down,
            screen_edge(x, y, left, top, right, bottom),
            (x, y),
            Instant::now(),
        )
    }))
    .unwrap_or(false)
}
pub(super) fn run(shared: Arc<Shared>) {
    let mut capture = Capture {
        shared,
        scroll: ScrollAccumulator::default(),
        buttons: ButtonTracker::default(),
    };
    while !capture.shared.stop.load(Ordering::Acquire) {
        unsafe {
            axonkey_macos_mouse_run(
                &mut capture as *mut _ as *mut c_void,
                stop,
                ready,
                scroll,
                button,
            );
        }
        capture.shared.ready.store(false, Ordering::Release);
        for _ in 0..20 {
            if capture.shared.stop.load(Ordering::Acquire) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}
pub(super) fn execute(behavior: &NativeBehavior) {
    super::super::macos::execute_behaviors(std::slice::from_ref(behavior));
}
