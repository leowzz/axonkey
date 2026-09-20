use super::{edge_width, screen_edge, ButtonTracker, ScrollAccumulator, Shared};
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

fn canonical_button(raw: i32) -> Option<usize> {
    match raw {
        0 => Some(0),
        1 => Some(1),
        3 => Some(2),
        4 => Some(3),
        _ => None,
    }
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
    let capture = &*(context as *mut Capture);
    capture.shared.ready.store(value, Ordering::Release);
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
        let edge = screen_edge(x, y, left, top, right, bottom, edge_width(&capture.shared));
        let previous_edge = capture.scroll.edge;
        capture.scroll.enter(edge);
        if previous_edge != edge {
            log::info!(
                target: "axonkey::input",
                "Mouse edge changed: edge={edge:?}, position=({x:.1},{y:.1}), bounds=({left:.1},{top:.1})-({right:.1},{bottom:.1})",
            );
        }
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
        let width = edge_width(&capture.shared);
        let edge = screen_edge(x, y, left, top, right, bottom, width);
        let button = canonical_button(index);
        let active = capture.shared.active.load(Ordering::Acquire);
        let log_level = if edge.is_some() {
            log::Level::Info
        } else {
            log::Level::Debug
        };
        log::log!(
            target: "axonkey::input",
            log_level,
            "Mouse button received: raw_button={}, button={button:?}, phase={}, edge={edge:?}, edge_width={width:.1}, position=({x:.1},{y:.1}), bounds=({left:.1},{top:.1})-({right:.1},{bottom:.1}), active={active}",
            index,
            if down { "down" } else { "up" },
        );
        let consumed = button.is_some_and(|button| {
            capture.buttons.event(
                &capture.shared,
                button,
                down,
                edge,
                (x, y),
                Instant::now(),
            )
        });
        log::log!(
            target: "axonkey::input",
            log_level,
            "Mouse button handled: raw_button={}, phase={}, edge={edge:?}, consumed={consumed}",
            index,
            if down { "down" } else { "up" },
        );
        consumed
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
pub(super) fn execute(behavior: &NativeBehavior, hold_ms: u64) {
    super::super::macos::execute_mouse_behavior(behavior, hold_ms);
}

#[cfg(test)]
mod tests {
    use super::canonical_button;

    #[test]
    fn middle_is_ignored_and_side_buttons_keep_their_numbers() {
        assert_eq!(canonical_button(0), Some(0));
        assert_eq!(canonical_button(1), Some(1));
        assert_eq!(canonical_button(2), None);
        assert_eq!(canonical_button(3), Some(2));
        assert_eq!(canonical_button(4), Some(3));
        assert_eq!(canonical_button(5), None);
    }
}
