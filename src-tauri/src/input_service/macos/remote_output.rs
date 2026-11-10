use super::*;
use crate::input_service::remote_actions::{Output, RemoteKey};
use crate::input_service::ProfileDirection;

impl RemoteKey for MacKey {
    fn chord(behavior: &NativeBehavior) -> Option<Vec<Self>> {
        behavior_chord(behavior)
    }

    fn original(button: &str) -> Option<Self> {
        let (page, usage) = crate::devices::descriptor_registry::KINDS
            .iter()
            .find_map(|kind| crate::devices::descriptor_registry::original_usage(kind, button))?;
        mac_key_for_hid_usage(page, usage)
    }
}

#[derive(Default)]
pub(crate) struct RemoteOutput {
    held: Vec<MacKey>,
    repeat_due: Option<Instant>,
}

impl RemoteOutput {
    pub(crate) fn emit(
        &mut self,
        output: Output<MacKey>,
        instance_id: &str,
        switch: &dyn Fn(ProfileDirection, bool),
    ) {
        // Always allow releases after permission loss so local state is cleared.
        if !matches!(output, Output::Key(_, false)) && !InputService::accessibility_granted() {
            return;
        }
        let behavior = match output {
            Output::LibraryTrigger(input, sources) => {
                crate::library_usage::record_trigger(&format!("{instance_id}:{input}"), &sources);
                return;
            }
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
            Output::TypeText(text) => NativeBehavior::TypeText {
                enabled: true,
                text,
            },
            Output::OpenPath(path) => NativeBehavior::OpenPath {
                enabled: true,
                path,
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
    fn descriptor_hid_sources_preserve_platform_original_output() {
        for (key, expected) in [
            ("cmiotA15.confirm", MacKey::keyboard(36)),
            ("cmiotA15.home", MacKey::keyboard(115)),
            ("cmiotA15.back", MacKey::keyboard(51)),
            ("cmiotA15.volumeUp", MacKey::system(0)),
            ("cmiotA15.volumeDown", MacKey::system(1)),
            ("cmiotA15.mute", MacKey::system(7)),
            ("cmiotA15.channelUp", MacKey::keyboard(116)),
            ("cmiotA15.channelDown", MacKey::keyboard(121)),
            ("xmBt29.digit1", MacKey::keyboard(18)),
            ("xmBt29.digit0", MacKey::keyboard(29)),
            ("xmBt29.delete", MacKey::keyboard(51)),
            ("obeRcuR5.back", MacKey::keyboard(53)),
            ("obeRcuR5.volumeUp", MacKey::system(0)),
            ("obeRcuR5.up", MacKey::keyboard(126)),
        ] {
            assert_eq!(MacKey::original(key), Some(expected), "{key}");
        }
        for key in [
            "cmiotA15.voice",
            "obeRcuR5.voice",
            "obeRcuR5.locate",
            "unknown",
        ] {
            assert_eq!(MacKey::original(key), None, "{key}");
        }
    }

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
        assert_eq!(
            outputs,
            vec![
                Output::LibraryTrigger("cmiotA15.voice", vec![]),
                Output::Key(right_option, true)
            ]
        );
        outputs.clear();
        actions.edge("cmiotA15.voice", false, &settings, now);
        actions.tick(now, |output| outputs.push(output));
        assert_eq!(outputs, vec![Output::Key(right_option, false)]);
        assert_eq!(MacKey::original("cmiotA15.voice"), None);
    }
}
