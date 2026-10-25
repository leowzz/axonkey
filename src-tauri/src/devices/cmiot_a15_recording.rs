//! Recording control only; this module does not receive or process audio.
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RecordingMode {
    #[default]
    Hold,
    Click,
}

#[derive(Default)]
pub(crate) struct RecordingControl {
    mode: RecordingMode,
    enabled: bool,
    pressed: bool,
    // Commanded device state, not proof that audio is being produced.
    recording: bool,
}

impl RecordingControl {
    pub(crate) fn is_recording(&self) -> bool {
        self.recording
    }
    pub(crate) fn synchronize<E>(
        &mut self,
        mode: RecordingMode,
        enabled: bool,
        mut send: impl FnMut([u8; 2]) -> Result<(), E>,
    ) -> Result<(), E> {
        if self.mode != mode || self.enabled != enabled {
            self.stop(&mut send)?;
            self.mode = mode;
            self.enabled = enabled;
        }
        Ok(())
    }

    pub(crate) fn edge<E>(
        &mut self,
        pressed: bool,
        mut send: impl FnMut([u8; 2]) -> Result<(), E>,
    ) -> Result<(), E> {
        if self.pressed == pressed {
            return Ok(());
        }
        self.pressed = pressed;
        if !self.enabled {
            return Ok(());
        }
        let next = match self.mode {
            RecordingMode::Hold => pressed,
            RecordingMode::Click if pressed => !self.recording,
            RecordingMode::Click => return Ok(()),
        };
        if next != self.recording {
            send([0xfb, u8::from(next)])?;
            self.recording = next;
        }
        Ok(())
    }

    pub(crate) fn stop<E>(
        &mut self,
        mut send: impl FnMut([u8; 2]) -> Result<(), E>,
    ) -> Result<(), E> {
        if self.recording {
            send([0xfb, 0])?;
            self.recording = false;
        }
        Ok(())
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_and_click_send_exact_reports_without_repeat_toggling() {
        for (mode, edges) in [
            (RecordingMode::Hold, vec![true, true, false, false]),
            (
                RecordingMode::Click,
                vec![true, true, false, true, true, false],
            ),
        ] {
            let mut control = RecordingControl::default();
            let mut reports = Vec::new();
            let mut send = |report| {
                reports.push(report);
                Ok::<_, ()>(())
            };
            control.synchronize(mode, true, &mut send).unwrap();
            for edge in edges {
                control.edge(edge, &mut send).unwrap();
            }
            assert_eq!(reports, vec![[0xfb, 1], [0xfb, 0]]);
            assert!(!control.recording);
        }
    }
    #[test]
    fn switching_mode_or_disabling_stops_recording_without_restarting_held_key() {
        for (mode, enabled) in [(RecordingMode::Hold, true), (RecordingMode::Click, false)] {
            let mut control = RecordingControl::default();
            let mut reports = Vec::new();
            let mut send = |r| {
                reports.push(r);
                Ok::<_, ()>(())
            };
            control
                .synchronize(RecordingMode::Click, true, &mut send)
                .unwrap();
            control.edge(true, &mut send).unwrap();
            control.synchronize(mode, enabled, &mut send).unwrap();
            control.edge(true, &mut send).unwrap();
            control.edge(false, &mut send).unwrap();
            assert_eq!(reports, vec![[0xfb, 1], [0xfb, 0]]);
        }
    }
    #[test]
    fn failed_writes_do_not_commit_state_and_failed_stop_can_be_retried() {
        let mut control = RecordingControl::default();
        control
            .synchronize(RecordingMode::Click, true, |_| Ok::<_, ()>(()))
            .unwrap();
        assert!(control.edge(true, |_| Err(())).is_err());
        assert!(!control.recording);
        control.edge(false, |_| Ok::<_, ()>(())).unwrap();
        control.edge(true, |_| Ok::<_, ()>(())).unwrap();
        assert!(control.stop(|_| Err(())).is_err());
        assert!(control.recording);
        control
            .stop(|r| {
                assert_eq!(r, [0xfb, 0]);
                Ok::<_, ()>(())
            })
            .unwrap();
        control.reset();
        assert!(!control.recording);
        assert!(!control.pressed);
    }
}
