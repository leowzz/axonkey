//! RC003 keeps its original macOS capture, hardware remapping and gesture engine.
use super::super::{
    macos::{InputService, RemoteInstance},
    NativeSettings, ProfileDirection,
};
use std::{
    ffi::CString,
    sync::mpsc::{channel, Receiver, TryRecvError},
    thread,
    time::{Duration, Instant},
};

pub(super) struct RemoteReader {
    service: InputService,
    reports: Receiver<Vec<u8>>,
}
impl RemoteReader {
    pub fn open(
        serial: &str,
        settings: NativeSettings,
        is_current: Box<dyn Fn() -> bool + Send + Sync>,
        switch_profile: Box<dyn Fn(ProfileDirection, bool) + Send + Sync>,
    ) -> Result<Self, String> {
        let serial = CString::new(serial).map_err(|e| e.to_string())?;
        let (tx, reports) = channel();
        let service = InputService::start_bound(
            settings,
            RemoteInstance {
                serial,
                is_current,
                switch_profile,
                on_report: Box::new(move |report_id, bytes| {
                    let mut report = Vec::with_capacity(7);
                    if bytes.len() == 6 {
                        report.push(report_id as u8);
                    }
                    report.extend_from_slice(bytes);
                    let _ = tx.send(report);
                }),
            },
        );
        let reader = Self { service, reports };
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            let status = reader.service.status();
            if status.capture_active && status.error.is_none() {
                return Ok(reader);
            }
            if Instant::now() >= until {
                return Err(status
                    .error
                    .unwrap_or_else(|| "遥控器拦截未就绪，请检查连接和系统权限".into()));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        match self.reports.try_recv() {
            Ok(report) => {
                let len = report.len().min(buffer.len());
                buffer[..len].copy_from_slice(&report[..len]);
                Ok(len)
            }
            Err(TryRecvError::Empty) => {
                let status = self.service.status();
                if let Some(error) = status.error {
                    return Err(error);
                }
                if !status.device_connected {
                    return Err("遥控器已断开连接".into());
                }
                if !status.capture_active {
                    return Err("遥控器拦截已停止".into());
                }
                Ok(0)
            }
            Err(TryRecvError::Disconnected) => Err("遥控器监听已停止".into()),
        }
    }
}
