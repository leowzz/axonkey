//! Quarbor Universal Keyboard Driver v1 named-pipe client.
//!
//! The universal driver keeps physical input and synthetic Windows output in
//! one protobuf connection. The client completes the Hello/BasicInfo handshake
//! before exposing the connection, then drains reports while correlating command
//! acknowledgements with strictly increasing request IDs.
use prost::Message;
use std::{
    collections::VecDeque,
    fs::OpenOptions,
    io,
    os::windows::{fs::OpenOptionsExt, io::IntoRawHandle},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::{
    net::windows::named_pipe::NamedPipeClient,
    runtime::{Builder, Runtime},
};

#[allow(dead_code)]
mod proto {
    include!(concat!(env!("OUT_DIR"), "/quarbor.keyboard.v1.rs"));
}

const MAX_REPORT: usize = 65_536;
const MAX_MESSAGE: usize = 66_048;
const FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const UNIVERSAL_DRIVER_NAME: &str = "QuarborUniversalKeyboardDriver";
const ERROR_INVALID_DATA: u32 = 13;
const ERROR_NOT_SUPPORTED: u32 = 50;

#[derive(Clone, Debug, Default)]
pub(super) struct Metadata {
    pub sequence: u64,
    pub timestamp: u64,
    pub dropped: u64,
    pub status: u32,
}

#[derive(Clone, Debug)]
pub(super) struct Capabilities {
    pub input_report_bytes: u32,
    pub queue_capacity: u32,
    pub flags: u32,
    pub report_ids: [u8; 32],
}

#[derive(Clone, Debug)]
pub(super) enum Event {
    Hello(Metadata),
    Capabilities(Capabilities),
    Report {
        metadata: Metadata,
        bytes: Vec<u8>,
        usages: Result<Vec<u16>, u32>,
    },
    Status(Metadata),
    CommandAccepted(u64),
}

#[derive(PartialEq)]
enum Stage {
    Hello,
    BasicInfo,
    Reports,
}

pub(super) struct Client {
    pipe: Option<NamedPipeClient>,
    instance_id: String,
    stage: Stage,
    report_ids: [u8; 32],
    frame: Box<[u8; MAX_MESSAGE + 4]>,
    offset: usize,
    target: usize,
    started: Option<Instant>,
    key_injection: bool,
    mouse_injection: bool,
    next_request: u64,
    max_payload: usize,
    outgoing: VecDeque<(Vec<u8>, usize)>,
    pending: VecDeque<(u64, Instant, String)>,
}

fn pipe_name(instance_id: &str) -> String {
    // The SDK uppercases ASCII letters only, then hashes UTF-16LE bytes.
    let mut hash = 0xcbf29ce484222325u64;
    for unit in instance_id.to_ascii_uppercase().encode_utf16() {
        for byte in unit.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!(r"\\.\pipe\Quarbor.UniversalKeyboard.v1.{hash:016X}")
}

/// Decode the RC003 input source carried by the BLE parent pipe.
///
/// The Universal driver deliberately exposes a passive vendor collection for
/// `BTHLEDEVICE`, so its descriptor cannot be passed to `HidP_GetUsages` as a
/// keyboard descriptor. RC003's HOGP input is a report ID followed by
/// little-endian 16-bit keyboard usages. Some firmware/Windows combinations
/// omit the report ID or use the standard boot-keyboard layout, so accept
/// those wire forms while keeping the decoding scoped to this known source.
fn decode_rc003_report(bytes: &[u8]) -> Result<Vec<u16>, u32> {
    if bytes.is_empty() {
        return Err(ERROR_INVALID_DATA);
    }

    if bytes.len() == 8 {
        // Unnumbered boot keyboard report: modifiers, reserved, six usages.
        return Ok(bytes[2..]
            .iter()
            .copied()
            .filter(|usage| *usage != 0)
            .map(u16::from)
            .collect());
    }

    let payload = if bytes.len() == 9 && bytes[0] == 0x01 && bytes[1] == 0 && bytes[2] == 0 {
        // Some HID stacks retain a three-byte report header before the three
        // 16-bit RC003 usage slots.
        &bytes[3..]
    } else if bytes[0] == 0x01 && bytes.len() >= 7 {
        // Numbered RC003 vendor report. The remaining bytes are 16-bit usage
        // slots; this also handles a four-slot report without special casing.
        &bytes[1..]
    } else if bytes.len() % 2 == 0 {
        // A report without the optional ID slot.
        bytes
    } else {
        return Err(ERROR_NOT_SUPPORTED);
    };

    if payload.len() % 2 != 0 {
        return Err(ERROR_INVALID_DATA);
    }

    Ok(payload
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .filter(|usage| *usage != 0)
        .collect())
}

fn synthetic_usage_supported(page: u16, usage: u16, report_ids: &[u8; 32]) -> bool {
    let report_id: usize = match page {
        0x07 if (0x04..=0xA4).contains(&usage)
            || (0xB0..=0xDD).contains(&usage)
            || (0xE0..=0xE7).contains(&usage) =>
        {
            1
        }
        0x0C if matches!(
            usage,
            0x00B0
                | 0x00B1
                | 0x00B5
                | 0x00B6
                | 0x00B7
                | 0x00CD
                | 0x00E2
                | 0x00E9
                | 0x00EA
                | 0x0183
                | 0x018A
                | 0x0192
                | 0x0194
                | 0x0221
                | 0x0223
                | 0x0224
                | 0x0225
                | 0x0226
                | 0x0227
                | 0x022A
        ) =>
        {
            2
        }
        0x09 if (1..=3).contains(&usage) => 3,
        _ => return false,
    };
    report_ids[report_id / 8] & (1 << (report_id % 8)) != 0
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid Quarbor Universal stream",
    )
}

fn pipe_runtime() -> io::Result<&'static Runtime> {
    static RUNTIME: OnceLock<io::Result<Runtime>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(1)
                .enable_io()
                .thread_name("Axonkey Universal pipe IO")
                .build()
        })
        .as_ref()
        .map_err(|error| io::Error::new(error.kind(), error.to_string()))
}

impl Client {
    pub fn connect(instance_id: &str) -> io::Result<Self> {
        Self::connect_path(&pipe_name(instance_id), instance_id)
    }

    pub(super) fn connect_path(path: &str, instance_id: &str) -> io::Result<Self> {
        let _guard = pipe_runtime()?.enter();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            // The driver ACL grants GENERIC_READ and FILE_WRITE_DATA, but not
            // GENERIC_WRITE (which would also request FILE_CREATE_PIPE_INSTANCE).
            .access_mode(0x8000_0000 | 0x0002)
            .share_mode(0)
            .custom_flags(0x4000_0000) // FILE_FLAG_OVERLAPPED
            .security_qos_flags(0x0011_0000) // SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
            .open(path)?;
        let pipe = unsafe { NamedPipeClient::from_raw_handle(file.into_raw_handle()) }?;
        Ok(Self {
            pipe: Some(pipe),
            instance_id: instance_id.into(),
            stage: Stage::Hello,
            report_ids: [0; 32],
            frame: Box::new([0; MAX_MESSAGE + 4]),
            offset: 0,
            target: 4,
            started: None,
            key_injection: false,
            mouse_injection: false,
            next_request: 1,
            max_payload: MAX_MESSAGE,
            outgoing: VecDeque::new(),
            pending: VecDeque::new(),
        })
    }

    pub fn ready(&self) -> bool {
        self.pipe.is_some() && self.stage == Stage::Reports
    }

    pub fn supports_key(&self, page: u16, usage: u16) -> bool {
        self.ready()
            && self.key_injection
            && synthetic_usage_supported(page, usage, &self.report_ids)
    }

    pub fn supports_mouse_move(&self) -> bool {
        self.ready() && self.mouse_injection && synthetic_usage_supported(0x09, 1, &self.report_ids)
    }

    pub fn send_key(&mut self, page: u16, usage: u16, down: bool) -> io::Result<u64> {
        if !self.key_injection {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Quarbor driver does not support SendKey",
            ));
        }
        self.command(
            proto::client_message::Body::Keysend(proto::KeySend {
                keys: vec![proto::Key {
                    usage_page: page.into(),
                    usage: usage.into(),
                    report_id: None,
                }],
                action: if down { 1 } else { 2 },
            }),
            format!(
                "SendKey({page:#06X}, {usage:#06X}, {})",
                if down { "down" } else { "up" }
            ),
        )
    }

    pub fn move_mouse(&mut self, x: i32, y: i32, wheel: i32, pan: i32) -> io::Result<u64> {
        if !self.mouse_injection {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Quarbor driver does not support MoveMouse",
            ));
        }
        if [x, y, wheel, pan]
            .iter()
            .any(|value| !(-127..=127).contains(value))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Quarbor MoveMouse values must be in -127..=127",
            ));
        }
        self.command(
            proto::client_message::Body::MouseMove(proto::MouseMove { x, y, wheel, pan }),
            format!("MoveMouse({x}, {y}, {wheel}, {pan})"),
        )
    }

    pub fn reset_input(&mut self) -> io::Result<u64> {
        self.command(
            proto::client_message::Body::ResetInput(proto::ResetInput {}),
            "ResetInput".into(),
        )
    }

    fn command(
        &mut self,
        body: proto::client_message::Body,
        description: String,
    ) -> io::Result<u64> {
        if !self.ready() {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "Quarbor handshake incomplete",
            ));
        }
        self.enqueue(body, description)
    }

    fn enqueue(
        &mut self,
        body: proto::client_message::Body,
        description: String,
    ) -> io::Result<u64> {
        if self.pending.len() >= 64 {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Quarbor command queue full",
            ));
        }
        let request_id = self.next_request;
        self.next_request = request_id.checked_add(1).ok_or_else(invalid)?;
        let bytes = proto::ClientMessage {
            request_id,
            body: Some(body),
        }
        .encode_to_vec();
        if !(1..=self.max_payload).contains(&bytes.len()) {
            return Err(invalid());
        }
        let frame = [(bytes.len() as u32).to_le_bytes().to_vec(), bytes].concat();
        self.outgoing.push_back((frame, 0));
        self.pending
            .push_back((request_id, Instant::now(), description));
        self.flush().inspect_err(|_| {
            self.pipe = None;
        })?;
        Ok(request_id)
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some((id, started, description)) = self.pending.front() {
            if started.elapsed() >= FRAME_TIMEOUT {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("Quarbor request {id} {description}: response timeout"),
                ));
            }
        }
        let pipe = self
            .pipe
            .as_ref()
            .ok_or_else(|| io::Error::from_raw_os_error(6))?;
        while let Some((frame, offset)) = self.outgoing.front_mut() {
            match pipe.try_write(&frame[*offset..]) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "Quarbor pipe write zero",
                    ))
                }
                Ok(bytes) => {
                    *offset += bytes;
                    if *offset == frame.len() {
                        self.outgoing.pop_front();
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub fn poll(&mut self) -> io::Result<Option<Event>> {
        let result = self.flush().and_then(|_| self.poll_frame());
        if result.is_err() {
            self.pipe = None;
            self.frame.fill(0);
            self.outgoing.clear();
            self.pending.clear();
        }
        result
    }

    fn check_frame_timeout(&self) -> io::Result<()> {
        if self
            .started
            .is_some_and(|time| time.elapsed() >= FRAME_TIMEOUT)
        {
            return Err(io::Error::from_raw_os_error(1460)); // ERROR_TIMEOUT
        }
        Ok(())
    }

    fn poll_frame(&mut self) -> io::Result<Option<Event>> {
        self.check_frame_timeout()?;
        for _ in 0..8 {
            let pipe = self
                .pipe
                .as_ref()
                .ok_or_else(|| io::Error::from_raw_os_error(6))?;
            match pipe.try_read(&mut self.frame[self.offset..self.target]) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "Quarbor pipe closed",
                    ))
                }
                Ok(bytes) => {
                    self.started.get_or_insert_with(Instant::now);
                    self.offset += bytes;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) => return Err(error),
            }
            self.check_frame_timeout()?;
            if self.offset != self.target {
                continue;
            }
            if self.target == 4 {
                let size = u32::from_le_bytes(self.frame[..4].try_into().unwrap()) as usize;
                let max = self.max_payload.min(MAX_MESSAGE);
                if !(1..=max).contains(&size) {
                    return Err(invalid());
                }
                self.target += size;
                continue;
            }
            let message =
                proto::ServerMessage::decode(&self.frame[4..self.target]).map_err(|_| invalid())?;
            self.frame[..self.target].fill(0);
            self.offset = 0;
            self.target = 4;
            self.started = None;
            return self.accept(message).map(Some);
        }
        Ok(None)
    }

    fn take_pending(&mut self, request_id: u64) -> io::Result<(u64, Instant, String)> {
        if request_id == 0 {
            return Err(invalid());
        }
        let position = self
            .pending
            .iter()
            .position(|pending| pending.0 == request_id)
            .ok_or_else(invalid)?;
        self.pending.remove(position).ok_or_else(invalid)
    }

    fn accept_result(&mut self, request_id: u64, status: u32) -> io::Result<Event> {
        let (id, _, description) = self.take_pending(request_id)?;
        if status != 0 {
            return Err(io::Error::other(format!(
                "Quarbor request {id} {description}: NTSTATUS=0x{status:08X}"
            )));
        }
        Ok(Event::CommandAccepted(id))
    }

    fn accept_basic_info(&mut self, request_id: u64, info: proto::BasicInfo) -> io::Result<Event> {
        if self.stage != Stage::BasicInfo {
            return Err(invalid());
        }
        self.take_pending(request_id)?;
        if info.driver_name != UNIVERSAL_DRIVER_NAME
            || info.device_instance_id.is_empty()
            || info.device_instance_id.contains('\0')
            || info.device_instance_id.encode_utf16().count() > 511
            || !self
                .instance_id
                .eq_ignore_ascii_case(&info.device_instance_id)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Quarbor BasicInfo device or driver mismatch",
            ));
        }
        self.report_ids = [0; 32];
        for report_id in [
            info.keyboard_report_id,
            info.media_report_id,
            info.mouse_report_id,
        ] {
            if report_id > 255 {
                return Err(invalid());
            }
            if report_id != 0 {
                self.report_ids[report_id as usize / 8] |= 1 << (report_id % 8);
            }
        }
        self.key_injection = info.supports_keysend;
        self.mouse_injection = info.supports_mouse_move;
        self.stage = Stage::Reports;
        let mut flags = 0;
        if self.report_ids.iter().any(|value| *value != 0) {
            flags |= 1;
        }
        if info.supports_keysend {
            flags |= 2;
        }
        if info.supports_mouse_move {
            flags |= 8;
        }
        if info.supports_input_status {
            flags |= 4;
        }
        Ok(Event::Capabilities(Capabilities {
            input_report_bytes: info.keyboard_report_bytes,
            queue_capacity: info.input_queue_capacity,
            flags,
            report_ids: self.report_ids,
        }))
    }

    fn accept(&mut self, message: proto::ServerMessage) -> io::Result<Event> {
        use proto::server_message::Body;
        match (message.body, &self.stage) {
            (Some(Body::Hello(hello)), Stage::Hello) => {
                if message.request_id != 0
                    || hello.protocol_version != 2
                    || !(1..=MAX_MESSAGE as u32).contains(&hello.max_payload_bytes)
                {
                    return Err(invalid());
                }
                self.max_payload = hello.max_payload_bytes as usize;
                self.stage = Stage::BasicInfo;
                self.enqueue(
                    proto::client_message::Body::QueryBasicInfo(proto::QueryBasicInfo {}),
                    "QueryBasicInfo".into(),
                )?;
                Ok(Event::Hello(Metadata::default()))
            }
            (Some(Body::BasicInfo(info)), Stage::BasicInfo) => {
                self.accept_basic_info(message.request_id, info)
            }
            (Some(Body::PhysicalReport(report)), Stage::Reports) => {
                if message.request_id != 0
                    || report.sequence == 0
                    || !(1..=MAX_REPORT).contains(&report.data.len())
                {
                    return Err(invalid());
                }
                let metadata = Metadata {
                    sequence: report.sequence,
                    timestamp: report.timestamp_filetime,
                    dropped: report
                        .queue_overwritten
                        .saturating_add(report.queue_cleared),
                    status: 0,
                };
                let usages = decode_rc003_report(&report.data);
                Ok(Event::Report {
                    metadata,
                    bytes: report.data,
                    usages,
                })
            }
            (Some(Body::InputResult(result)), Stage::BasicInfo | Stage::Reports) => {
                self.accept_result(message.request_id, result.ntstatus)
            }
            (Some(Body::PhysicalWriteResult(result)), Stage::Reports) => {
                self.accept_result(message.request_id, result.ntstatus)
            }
            (Some(Body::InputStatus(status)), Stage::Reports) => {
                self.take_pending(message.request_id)?;
                Ok(Event::Status(Metadata {
                    sequence: 0,
                    timestamp: 0,
                    dropped: u64::from(status.queued_reports),
                    status: status.last_read_status,
                }))
            }
            _ => Err(invalid()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_universal_pipe_hash_contract() {
        assert_eq!(
            pipe_name(
                r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8_REV&00A4_C05D39C2CF83\8&7CE84E7&0&0055"
            ),
            r"\\.\pipe\Quarbor.UniversalKeyboard.v1.695F9E58CAB45BEF"
        );
    }

    #[test]
    fn reports_have_the_new_frame_limit() {
        assert_eq!(MAX_MESSAGE, 66_048);
        assert_eq!(MAX_REPORT, 65_536);
    }

    #[test]
    fn encodes_the_universal_basic_info_query() {
        let payload = proto::ClientMessage {
            request_id: 1,
            body: Some(proto::client_message::Body::QueryBasicInfo(
                proto::QueryBasicInfo {},
            )),
        }
        .encode_to_vec();
        assert_eq!(payload, [0x08, 0x01, 0x52, 0x00]);
    }

    #[test]
    fn decodes_rc003_numbered_usage_report() {
        assert_eq!(
            decode_rc003_report(&[1, 0x28, 0, 0x52, 0, 0, 0]).unwrap(),
            vec![0x28, 0x52]
        );
    }

    #[test]
    fn decodes_rc003_report_without_id_and_boot_report() {
        assert_eq!(
            decode_rc003_report(&[0x28, 0, 0x52, 0, 0, 0]).unwrap(),
            vec![0x28, 0x52]
        );
        assert_eq!(
            decode_rc003_report(&[0, 0, 0x28, 0, 0x52, 0, 0, 0]).unwrap(),
            vec![0x28, 0x52]
        );
        assert_eq!(
            decode_rc003_report(&[1, 0, 0, 0x28, 0, 0x52, 0, 0, 0]).unwrap(),
            vec![0x28, 0x52]
        );
    }

    #[test]
    fn rejects_incomplete_rc003_report() {
        assert_eq!(decode_rc003_report(&[1, 0, 0]), Err(ERROR_NOT_SUPPORTED));
    }

    #[test]
    fn recognizes_the_independent_output_usage_ranges() {
        let mut report_ids = [0; 32];
        report_ids[0] = (1 << 1) | (1 << 2) | (1 << 3);
        assert!(synthetic_usage_supported(0x07, 0x04, &report_ids));
        assert!(synthetic_usage_supported(0x07, 0xE7, &report_ids));
        assert!(synthetic_usage_supported(0x0C, 0x00E9, &report_ids));
        assert!(synthetic_usage_supported(0x09, 0x0001, &report_ids));
        assert!(synthetic_usage_supported(0x09, 0x0003, &report_ids));
        assert!(!synthetic_usage_supported(0x09, 0x0004, &report_ids));
        assert!(!synthetic_usage_supported(0x07, 0x00A5, &report_ids));
        assert!(!synthetic_usage_supported(0x07, 0xF1, &report_ids));
        assert!(!synthetic_usage_supported(0x0C, 0x0001, &report_ids));
    }
}
