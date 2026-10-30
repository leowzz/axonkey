use super::{HEIGHT, ON_CLICK, WIDTH};

extern "C" {
    fn axonkey_macos_recording_overlay(
        visible: bool,
        width: i32,
        height: i32,
        on_click: extern "C" fn(),
    );
}

pub(super) fn refresh_window(visible: bool) {
    unsafe { axonkey_macos_recording_overlay(visible, WIDTH, HEIGHT, clicked) };
}

extern "C" fn clicked() {
    if let Some(on_click) = ON_CLICK.get() {
        on_click();
    }
}
