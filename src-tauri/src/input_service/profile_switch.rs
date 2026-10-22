use super::ProfileDirection;
use serde::Serialize;
use std::sync::OnceLock;
use tauri::Emitter;

static EVENT_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(super) struct ProfileSwitchRequest {
    direction: ProfileDirection,
    wrap: bool,
}

pub(super) fn set_event_app(app: tauri::AppHandle) {
    let _ = EVENT_APP.set(app);
}

pub(super) fn execute(direction: ProfileDirection, wrap: bool) {
    if let Some(app) = EVENT_APP.get() {
        if let Err(error) = app.emit(
            "axonkey-switch-profile",
            ProfileSwitchRequest { direction, wrap },
        ) {
            log::warn!(target: "axonkey::input", "Cannot switch profile: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_switch_events_preserve_direction_and_wrap() {
        for direction in [ProfileDirection::Previous, ProfileDirection::Next] {
            for wrap in [false, true] {
                let value = serde_json::to_value(ProfileSwitchRequest { direction, wrap }).unwrap();
                assert_eq!(
                    value["direction"],
                    if direction == ProfileDirection::Previous {
                        "previous"
                    } else {
                        "next"
                    }
                );
                assert_eq!(value["wrap"], wrap);
            }
        }
    }
    #[test]
    fn switch_profile_settings_default_wrap_on_and_reject_invalid_values() {
        let behavior: super::super::NativeBehavior = serde_json::from_value(
            serde_json::json!({"type":"switchProfile","direction":"previous"}),
        )
        .unwrap();
        assert!(behavior.enabled());
        assert!(matches!(
            behavior,
            super::super::NativeBehavior::SwitchProfile {
                direction: ProfileDirection::Previous,
                wrap: true,
                ..
            }
        ));
        for value in [
            serde_json::json!({"type":"switchProfile","direction":"up"}),
            serde_json::json!({"type":"switchProfile","direction":"next","wrap":"true"}),
        ] {
            assert!(serde_json::from_value::<super::super::NativeBehavior>(value).is_err());
        }
    }
}
