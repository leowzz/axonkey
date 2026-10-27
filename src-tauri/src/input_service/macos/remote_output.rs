use super::*;
use crate::input_service::remote_actions::{Output, RemoteKey};
use crate::input_service::ProfileDirection;

impl RemoteKey for MacKey {
    fn chord(behavior: &NativeBehavior) -> Option<Vec<Self>> {
        behavior_chord(behavior)
    }

    fn original(button: &str) -> Option<Self> {
        let button = button.strip_prefix("cmiotA15.")?;
        if let Some(source) = SOURCE_KEYS.iter().find(|source| source.id == button) {
            // F8 is a vendor recording signal, not an ordinary keyboard key.
            return (button != "voice").then_some(source.original);
        }
        match button {
            "mute" => Some(Self::system(7)),
            "channelUp" => Some(Self::keyboard(116)),
            "channelDown" => Some(Self::keyboard(121)),
            _ => None,
        }
    }
}

#[derive(Default)]
pub(crate) struct RemoteOutput {
    held: Vec<MacKey>,
    repeat_due: Option<Instant>,
}

impl RemoteOutput {
    pub(crate) fn emit(&mut self, output: Output<MacKey>, switch: &dyn Fn(ProfileDirection, bool)) {
        // Always allow releases after permission loss so local state is cleared.
        if !matches!(output, Output::Key(_, false)) && !InputService::accessibility_granted() {
            return;
        }
        let behavior = match output {
            Output::Key(key, down) => {
                if down {
                    self.held.push(key);
                    if key.modifier_flag() == 0 {
                        self.repeat_due = Some(Instant::now() + Duration::from_millis(400));
                    }
                } else {
                    self.held.retain(|held| *held != key);
                }
                let flags = self
                    .held
                    .iter()
                    .fold(0, |flags, key| flags | key.modifier_flag());
                post_key(key, down, flags, false);
                return;
            }
            Output::SwitchProfile(direction, wrap) => {
                switch(direction, wrap);
                return;
            }
            Output::CursorMove(direction, distance) => NativeBehavior::CursorMove {
                enabled: true,
                direction,
                distance,
            },
            Output::MouseClick(button) => NativeBehavior::Mouse {
                enabled: true,
                button,
            },
            Output::Wheel(direction) => NativeBehavior::Wheel {
                enabled: true,
                direction,
            },
            Output::Paste(text) => NativeBehavior::Paste {
                enabled: true,
                text,
            },
            Output::OpenApp(path) => NativeBehavior::OpenApp {
                enabled: true,
                path,
            },
            Output::OpenWebsite(url) => NativeBehavior::OpenWebsite { enabled: true, url },
        };
        execute_behaviors(&[behavior]);
    }

    pub(crate) fn tick(&mut self) {
        let now = Instant::now();
        if self.repeat_due.is_some_and(|due| now >= due) && InputService::accessibility_granted() {
            if let Some(key) = self.held.iter().rev().find(|key| key.modifier_flag() == 0) {
                let flags = self
                    .held
                    .iter()
                    .fold(0, |flags, key| flags | key.modifier_flag());
                post_key(*key, true, flags, true);
            }
            self.repeat_due = Some(now + Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input_service::remote_actions::RemoteActions;

    #[test]
    fn a15_voice_mapping_holds_right_option_until_release() {
        let settings: NativeSettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "behaviors": {"cmiotA15.voice": {"click": [{"type": "key", "key": "RAlt"}]}}
        }))
        .unwrap();
        let mut actions = RemoteActions::<MacKey>::default();
        actions.synchronize(1, true);
        let now = Instant::now();
        let mut outputs = Vec::new();
        actions.edge("cmiotA15.voice", true, &settings, now);
        actions.tick(now, |output| outputs.push(output));
        let right_option = MacKey::modifier(61, FLAG_OPTION | FLAG_DEVICE_RIGHT_OPTION);
        assert_eq!(outputs, vec![Output::Key(right_option, true)]);
        outputs.clear();
        actions.edge("cmiotA15.voice", false, &settings, now);
        actions.tick(now, |output| outputs.push(output));
        assert_eq!(outputs, vec![Output::Key(right_option, false)]);
        assert_eq!(MacKey::original("cmiotA15.voice"), None);
    }
}
