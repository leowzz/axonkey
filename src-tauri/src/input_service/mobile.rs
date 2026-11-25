use super::{
    ownership::{HeldOutput, OwnershipLedger},
    MouseButton, NativeBehavior,
};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default, Debug)]
struct SessionAccumulators {
    ptr_x: f64,
    ptr_y: f64,
    scroll_x: f64,
    scroll_y: f64,
}

/// Platform-neutral executor for Axonkey Mobile control commands.
pub trait MobileInputBackend: Send + Sync {
    fn execute_behaviors(&self, behaviors: &[NativeBehavior]) -> Result<(), String>;
    fn inject_relative_motion(&self, dx: i32, dy: i32) -> Result<(), String>;
    fn inject_absolute_pointer(&self, u: f64, v: f64) -> Result<(), String>;
    fn inject_wheel(&self, delta: i32, horizontal: bool) -> Result<(), String>;
    fn inject_mouse_button(&self, button: MouseButton, down: bool) -> Result<(), String>;
    fn inject_key_edge(&self, key: &str, down: bool) -> Result<(), String>;
}

pub struct SystemMobileBackend;

impl MobileInputBackend for SystemMobileBackend {
    fn execute_behaviors(&self, behaviors: &[NativeBehavior]) -> Result<(), String> {
        #[cfg(windows)]
        {
            for behavior in behaviors {
                if !behavior.enabled() {
                    continue;
                }
                match behavior {
                    NativeBehavior::Delay { ms, .. } => {
                        std::thread::sleep(std::time::Duration::from_millis((*ms).min(10_000)));
                    }
                    _ => {
                        #[cfg(not(test))]
                        if super::mobile_quarbor::try_execute_behavior(behavior) {
                            continue;
                        }
                        super::windows::execute_mouse_behavior(behavior, 0);
                    }
                }
            }
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            super::macos::execute_behaviors(behaviors);
            return Ok(());
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = behaviors;
            Err("当前平台暂不支持移动输入执行".into())
        }
    }

    fn inject_relative_motion(&self, dx: i32, dy: i32) -> Result<(), String> {
        #[cfg(windows)]
        {
            #[cfg(not(test))]
            if super::mobile_quarbor::try_relative_motion(dx, dy) {
                return Ok(());
            }
            return super::windows::inject_relative_motion(dx, dy);
        }
        #[cfg(not(windows))]
        {
            let _ = (dx, dy);
            Err("当前平台暂不支持相对触控板移动".into())
        }
    }

    fn inject_absolute_pointer(&self, u: f64, v: f64) -> Result<(), String> {
        #[cfg(windows)]
        {
            return super::windows::inject_absolute_virtual_desk(u, v);
        }
        #[cfg(not(windows))]
        {
            let _ = (u, v);
            Err("当前平台暂不支持绝对光标映射".into())
        }
    }

    fn inject_wheel(&self, delta: i32, horizontal: bool) -> Result<(), String> {
        #[cfg(windows)]
        {
            return super::windows::inject_wheel_delta(delta, horizontal);
        }
        #[cfg(not(windows))]
        {
            let _ = (delta, horizontal);
            Err("当前平台暂不支持相对滚轮注入".into())
        }
    }

    fn inject_mouse_button(&self, button: MouseButton, down: bool) -> Result<(), String> {
        #[cfg(windows)]
        {
            #[cfg(not(test))]
            if super::mobile_quarbor::try_mouse_button_edge(button, down)? {
                return Ok(());
            }
            return super::windows::inject_mouse_button_edge(button, down);
        }
        #[cfg(not(windows))]
        {
            let _ = (button, down);
            Err("当前平台暂不支持显式鼠标按键边沿".into())
        }
    }

    fn inject_key_edge(&self, key: &str, down: bool) -> Result<(), String> {
        #[cfg(windows)]
        {
            #[cfg(not(test))]
            if super::mobile_quarbor::try_key_edge(key, down)? {
                return Ok(());
            }
            return super::windows::inject_virtual_key_edge(key, down);
        }
        #[cfg(not(windows))]
        {
            let _ = (key, down);
            Err("当前平台暂不支持显式键盘边沿".into())
        }
    }
}

/// Serializes input injection and ownership tracking across all mobile sessions.
pub struct MobileInputController<B: MobileInputBackend = SystemMobileBackend> {
    backend: B,
    state: Mutex<ControllerState>,
}

#[derive(Default)]
struct ControllerState {
    ledger: OwnershipLedger,
    accumulators: HashMap<String, SessionAccumulators>,
}

impl Default for MobileInputController<SystemMobileBackend> {
    fn default() -> Self {
        Self::new(SystemMobileBackend)
    }
}

impl<B: MobileInputBackend> MobileInputController<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            state: Mutex::new(ControllerState::default()),
        }
    }

    pub fn execute_behaviors(&self, behaviors: &[NativeBehavior]) -> Result<(), String> {
        let _guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.backend.execute_behaviors(behaviors)
    }

    pub fn pointer_motion(
        &self,
        session_id: &str,
        dx: f64,
        dy: f64,
        sensitivity: f64,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let acc = state.accumulators.entry(session_id.to_owned()).or_default();
        acc.ptr_x += dx * sensitivity;
        acc.ptr_y += dy * sensitivity;
        let step_x = acc.ptr_x.trunc() as i32;
        let step_y = acc.ptr_y.trunc() as i32;
        if step_x == 0 && step_y == 0 {
            return Ok(());
        }
        acc.ptr_x -= f64::from(step_x);
        acc.ptr_y -= f64::from(step_y);
        self.backend.inject_relative_motion(step_x, step_y)
    }

    pub fn pointer_absolute(&self, session_id: &str, u: f64, v: f64) -> Result<(), String> {
        if !u.is_finite() || !v.is_finite() {
            return Err("绝对坐标包含非有限浮点数".into());
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(acc) = state.accumulators.get_mut(session_id) {
            acc.ptr_x = 0.0;
            acc.ptr_y = 0.0;
        }
        let u_clamped = u.clamp(0.0, 1.0);
        let v_clamped = v.clamp(0.0, 1.0);
        self.backend.inject_absolute_pointer(u_clamped, v_clamped)
    }

    pub fn pointer_scroll(
        &self,
        session_id: &str,
        x: f64,
        y: f64,
        sensitivity: f64,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let acc = state.accumulators.entry(session_id.to_owned()).or_default();
        // 120 = WHEEL_DELTA on Windows; scale logical units smoothly while preserving remainder.
        acc.scroll_x += x * sensitivity * 12.0;
        acc.scroll_y += y * sensitivity * 12.0;
        let step_x = acc.scroll_x.trunc() as i32;
        let step_y = acc.scroll_y.trunc() as i32;
        if step_y != 0 {
            acc.scroll_y -= f64::from(step_y);
            self.backend.inject_wheel(step_y, false)?;
        }
        if step_x != 0 {
            acc.scroll_x -= f64::from(step_x);
            self.backend.inject_wheel(step_x, true)?;
        }
        Ok(())
    }

    pub fn pointer_button(
        &self,
        session_id: &str,
        press_id: &str,
        button: MouseButton,
        down: bool,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let targets = if down {
            state
                .ledger
                .acquire(session_id, press_id, vec![HeldOutput::MouseButton(button)])
        } else {
            state.ledger.release(session_id, press_id)
        };
        for out in targets {
            self.apply_held_output(&out, down)?;
        }
        Ok(())
    }

    pub fn hold_keys(
        &self,
        session_id: &str,
        press_id: &str,
        keys: Vec<String>,
        down: bool,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let targets = if down {
            let outputs = keys.into_iter().map(HeldOutput::Key).collect();
            state.ledger.acquire(session_id, press_id, outputs)
        } else {
            state.ledger.release(session_id, press_id)
        };
        for out in targets {
            self.apply_held_output(&out, down)?;
        }
        Ok(())
    }

    pub fn text_commit(&self, text: &str, paste_mode: bool, submit: bool) -> Result<(), String> {
        let _guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut behaviors = Vec::with_capacity(2);
        if paste_mode {
            behaviors.push(NativeBehavior::Paste {
                enabled: true,
                text: text.to_owned(),
            });
        } else {
            behaviors.push(NativeBehavior::TypeText {
                enabled: true,
                text: text.to_owned(),
            });
        }
        self.backend.execute_behaviors(&behaviors)?;
        if submit {
            let enter = [NativeBehavior::Key {
                enabled: true,
                key: "Enter".into(),
            }];
            self.backend.execute_behaviors(&enter)?;
        }
        Ok(())
    }

    pub fn revoke_session(&self, session_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.accumulators.remove(session_id);
        let to_release = state.ledger.revoke_owner(session_id);
        let all_idle = state.ledger.is_empty();
        let mut first_err: Option<String> = None;
        for out in to_release {
            if let Err(err) = self.apply_held_output(&out, false) {
                if first_err.is_none() {
                    first_err = Some(err);
                }
            }
        }
        #[cfg(all(windows, not(test)))]
        if all_idle {
            super::mobile_quarbor::reset_all_inputs();
        }
        #[cfg(not(all(windows, not(test))))]
        let _ = all_idle;
        match first_err {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    fn apply_held_output(&self, output: &HeldOutput, down: bool) -> Result<(), String> {
        match output {
            HeldOutput::MouseButton(btn) => self.backend.inject_mouse_button(*btn, down),
            HeldOutput::Key(key) => self.backend.inject_key_edge(key, down),
        }
    }
}
