//! RC003 uses the established macOS event filter when keyboard seizure is denied.
use super::super::macos::{axonkey_macos_input_run, NativeCallbacks, POWER_KEY_GUARD};
use std::{
    ffi::{c_void, CString},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{channel, Receiver, Sender, TryRecvError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

enum Event {
    Ready(&'static str),
    Report(Vec<u8>),
    Error(String),
}
struct Context {
    stop: Arc<AtomicBool>,
    events: Sender<Event>,
}
pub(super) struct RemoteReader {
    stop: Arc<AtomicBool>,
    events: Receiver<Event>,
    worker: Option<JoinHandle<()>>,
    pub state: &'static str,
}
impl RemoteReader {
    pub fn open(serial: &str) -> Result<Self, String> {
        let serial = CString::new(serial).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, events) = channel();
        let mut context = Context {
            stop: stop.clone(),
            events: tx,
        };
        let worker = thread::Builder::new()
            .name("Axonkey RC003 capture".into())
            .spawn(move || {
                let callbacks = NativeCallbacks {
                    context: (&mut context as *mut Context).cast(),
                    should_stop,
                    on_event,
                };
                let result = unsafe {
                    axonkey_macos_input_run(
                        &callbacks,
                        true,
                        &POWER_KEY_GUARD,
                        1,
                        std::ptr::null(),
                        0,
                        serial.as_ptr(),
                    )
                };
                if result != 0 {
                    let _ = context.events.send(Event::Error(format!(
                        "遥控器监听启动失败（0x{:08X}）",
                        result as u32
                    )));
                }
            })
            .map_err(|e| e.to_string())?;
        let mut reader = Self {
            stop,
            events,
            worker: Some(worker),
            state: "opening",
        };
        match reader.events.recv_timeout(Duration::from_secs(2)) {
            Ok(Event::Ready(state)) => {
                reader.state = state;
                Ok(reader)
            }
            Ok(Event::Error(error)) => Err(error),
            _ => Err("遥控器监听未就绪，请检查连接和系统权限".into()),
        }
    }
    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        loop {
            match self.events.try_recv() {
                Ok(Event::Report(report)) => {
                    let len = report.len().min(buffer.len());
                    buffer[..len].copy_from_slice(&report[..len]);
                    return Ok(len);
                }
                Ok(Event::Ready(state)) => self.state = state,
                Ok(Event::Error(error)) => return Err(error),
                Err(TryRecvError::Empty) => return Ok(0),
                Err(TryRecvError::Disconnected) => return Err("遥控器监听已停止".into()),
            }
        }
    }
}
impl Drop for RemoteReader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
unsafe extern "C" fn should_stop(context: *mut c_void) -> bool {
    (&*context.cast::<Context>()).stop.load(Ordering::Acquire)
}
unsafe extern "C" fn on_event(
    context: *mut c_void,
    event: i32,
    report_id: u32,
    bytes: *const u8,
    length: usize,
    code: i32,
) {
    let context = &*context.cast::<Context>();
    if event == 8 && !bytes.is_null() {
        let diagnostic = String::from_utf8_lossy(std::slice::from_raw_parts(bytes, length));
        log::debug!(target: "axonkey::devices", "{diagnostic}");
        #[cfg(test)]
        eprintln!("{diagnostic}");
    }
    let message = match event {
        // Filtered capture must also neutralize Power before loginwindow handles it.
        2 if code & 3 == 1 => Some(Event::Ready("exclusive")),
        2 if code & 3 == 2 && code & 4 != 0 => Some(Event::Ready("filtered")),
        2 => Some(Event::Error(
            "遥控器拦截未就绪，请检查输入监控和辅助功能权限".into(),
        )),
        3 => Some(Event::Error("遥控器已断开连接".into())),
        4 if report_id == 1 && !bytes.is_null() => {
            let bytes = std::slice::from_raw_parts(bytes, length);
            let report = if length == 6 {
                let mut report = vec![1];
                report.extend_from_slice(bytes);
                report
            } else {
                bytes.to_vec()
            };
            Some(Event::Report(report))
        }
        5 => Some(Event::Error(format!(
            "遥控器监听失败（0x{:08X}），请检查系统权限",
            code as u32
        ))),
        7 if code == 0 => Some(Event::Error("遥控器拦截暂未就绪，正在重新连接".into())),
        _ => None,
    };
    if let Some(message) = message {
        let _ = context.events.send(message);
    }
}
