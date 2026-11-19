use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CallNextHookEx, SetWindowsHookExW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_SYSKEYDOWN,
    },
};

pub(super) fn initialize_escape_listener() {
    // The overlay never takes keyboard focus; listen on Tauri's main message loop.
    let result = unsafe {
        GetModuleHandleW(None).and_then(|module| {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_keyboard), Some(module.into()), 0)
        })
    };
    if let Err(error) = result {
        log::warn!(target: "axonkey::quick_overlay", "Cannot listen for Escape: {error}");
    }
}

unsafe extern "system" fn on_keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if is_physical_escape_press(wparam.0 as u32, event) {
            super::dismiss_on_escape();
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn is_physical_escape_press(message: u32, event: &KBDLLHOOKSTRUCT) -> bool {
    matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN)
        && event.vkCode == 0x1b
        && event.flags & LLKHF_INJECTED == Default::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_dismissal_accepts_physical_presses_and_ignores_other_keys_releases_and_injection() {
        for (message, vk_code, flags, expected) in [
            (WM_KEYDOWN, 0x1b, Default::default(), true),
            (WM_SYSKEYDOWN, 0x1b, Default::default(), true),
            (WM_KEYDOWN, 0x41, Default::default(), false),
            (WM_KEYDOWN + 1, 0x1b, Default::default(), false),
            (WM_KEYDOWN, 0x1b, LLKHF_INJECTED, false),
        ] {
            let event = KBDLLHOOKSTRUCT {
                vkCode: vk_code,
                flags,
                ..Default::default()
            };
            assert_eq!(is_physical_escape_press(message, &event), expected);
        }
    }
}
