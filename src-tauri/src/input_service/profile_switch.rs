use super::ProfileDirection;
use serde::Serialize;
use std::sync::OnceLock;
use tauri::Emitter;

static EVENT_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DeviceId {
    Rc003,
    Mouse,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProfileSwitchRequest {
    device_id: DeviceId,
    direction: ProfileDirection,
    wrap: bool,
}

#[cfg(test)]
thread_local! {
    pub(super) static REQUESTS: std::cell::RefCell<Vec<ProfileSwitchRequest>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub(super) fn set_event_app(app: tauri::AppHandle) {
    let _ = EVENT_APP.set(app);
}

pub(super) fn execute(device_id: DeviceId, direction: ProfileDirection, wrap: bool) {
    let request = ProfileSwitchRequest {
        device_id,
        direction,
        wrap,
    };
    #[cfg(test)]
    REQUESTS.with(|requests| requests.borrow_mut().push(request));
    if let Some(app) = EVENT_APP.get() {
        if let Err(error) = app.emit("axonkey-switch-profile", request) {
            log::warn!(target: "axonkey::input", "Cannot switch profile: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_switch_events_preserve_device_direction_and_wrap() {
        for (device_id, serialized_id) in [(DeviceId::Rc003, "rc003"), (DeviceId::Mouse, "mouse")] {
            for direction in [ProfileDirection::Previous, ProfileDirection::Next] {
                for wrap in [false, true] {
                    let value = serde_json::to_value(ProfileSwitchRequest {
                        device_id,
                        direction,
                        wrap,
                    })
                    .unwrap();
                    assert_eq!(
                        value,
                        serde_json::json!({
                            "deviceId": serialized_id,
                            "direction": if direction == ProfileDirection::Previous {
                                "previous"
                            } else {
                                "next"
                            },
                            "wrap": wrap,
                        })
                    );
                }
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
