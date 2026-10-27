use super::*;
use crate::audio_service::AudioServiceManager;
use crate::devices::cmiot_a15::HidSession;
use crate::input_service::{
    macos::{MacKey, RemoteOutput},
    remote_actions::RemoteActions,
    NativeSettings,
};

pub(super) struct A15Reader {
    device: HidDevice,
    session: HidSession,
    settings: NativeSettings,
    actions: RemoteActions<MacKey>,
    output: RemoteOutput,
    app: Option<tauri::AppHandle>,
    instance_id: String,
    switch: Box<dyn Fn(ProfileDirection, bool)>,
    is_current: Box<dyn Fn() -> bool>,
}

impl A15Reader {
    pub(super) fn open(
        device: HidDevice,
        instance: &Instance,
        shared: &Arc<Shared>,
        cancel: &Arc<AtomicBool>,
    ) -> Self {
        let settings = NativeSettings {
            enabled: true,
            behaviors: active_mappings(instance),
            cmiot_a15_recording_mode: instance.cmiot_a15_recording_mode,
            ..Default::default()
        };
        let mut session = HidSession::default();
        session.start(instance.cmiot_a15_recording_mode);
        let mut actions = RemoteActions::default();
        actions.synchronize(1, true);
        let switch_shared = shared.clone();
        let id = instance.id.clone();
        let current_shared = shared.clone();
        let expected = instance.clone();
        let current_cancel = cancel.clone();
        Self {
            device,
            session,
            settings,
            actions,
            output: RemoteOutput::default(),
            app: shared.app.lock().unwrap().clone(),
            instance_id: instance.id.clone(),
            switch: Box::new(move |direction, wrap| {
                switch_profile(&switch_shared, &id, direction, wrap)
            }),
            is_current: Box::new(move || {
                actions_current(&current_shared, &expected, &current_cancel)
            }),
        }
    }

    pub(super) fn recording(&self) -> bool {
        self.session.recording()
    }

    pub(super) fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        if !(self.is_current)() {
            return Ok(0);
        }
        let len = self
            .device
            .read(buffer)
            .map_err(|error| error.to_string())?;
        if len > 0 {
            let (edges, pcm) = self
                .session
                .accept(&buffer[..len], |report| send(&self.device, report))?;
            for (button, down) in edges {
                self.actions
                    .edge(button, down, &self.settings, Instant::now());
            }
            if let Some(app) = &self.app {
                let audio = app.state::<AudioServiceManager>();
                audio.set_a15_input_state(Some(&self.instance_id), true, self.recording());
                if let Some(pcm) = pcm {
                    audio.push_a15_pcm(Some(&self.instance_id), &pcm.samples);
                }
            }
        }
        self.actions.tick(Instant::now(), |output| {
            if (self.is_current)() {
                self.output.emit(output, &*self.switch);
            }
        });
        self.output.tick();
        // Also publish idle connection state after the audio service is created.
        if len == 0 {
            if let Some(app) = &self.app {
                app.state::<AudioServiceManager>().set_a15_input_state(
                    Some(&self.instance_id),
                    true,
                    self.recording(),
                );
            }
        }
        Ok(len)
    }
}

impl Drop for A15Reader {
    fn drop(&mut self) {
        if let Err(error) = self.session.stop(|report| send(&self.device, report)) {
            log::warn!(target: "axonkey::audio", "Cannot stop A15 recording: {error}");
        }
        self.actions.cancel();
        self.actions.tick(Instant::now(), |output| {
            self.output.emit(output, &*self.switch)
        });
        if let Some(app) = &self.app {
            app.state::<AudioServiceManager>().set_a15_input_state(
                Some(&self.instance_id),
                false,
                false,
            );
        }
    }
}

fn send(device: &HidDevice, report: [u8; 2]) -> Result<(), String> {
    match device.write(&report) {
        Ok(2) => Ok(()),
        Ok(length) => Err(format!("A15 录音控制写入不完整：{length}/2")),
        Err(error) => Err(format!("A15 录音控制失败：{error}")),
    }
}
