//! Duplex v3 pipe transport implemented entirely in Rust.
use super::windows_hid::{KeyBindings, KeyboardDescriptor};
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

// Generated from the vendor SDK's original schema. No copied wire structures.
#[allow(dead_code)]
mod proto {
    include!(concat!(env!("OUT_DIR"), "/quarbor.hid.v3.rs"));
}

const MAX_REPORT: usize = 4096;
const MAX_MESSAGE: usize = 8192;
const FRAME_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug)]
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
        // Failed usage decoding never discards or alters the raw HID bytes.
        usages: Result<Vec<u16>, u32>,
    },
    Status(Metadata),
    CommandAccepted(u64),
}

#[derive(PartialEq)]
enum Stage {
    Hello,
    Capabilities,
    Reports,
}

pub(super) struct Client {
    pipe: Option<NamedPipeClient>,
    instance_id: String,
    stage: Stage,
    descriptor: Result<KeyboardDescriptor, u32>,
    key_bindings: KeyBindings,
    report_ids: [u8; 32],
    frame: Box<[u8; MAX_MESSAGE + 4]>,
    offset: usize,
    target: usize,
    started: Option<Instant>,
    key_injection: bool,
    next_request: u64,
    outgoing: VecDeque<(Vec<u8>, usize)>,
    pending: VecDeque<(u64, Instant, String)>,
}

pub(super) fn pipe_name(instance_id: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for unit in instance_id.to_ascii_uppercase().encode_utf16() {
        for byte in unit.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!(r"\\.\pipe\Quarbor.HidUserFilter.v3.{hash:016X}")
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid Quarbor v3 stream")
}

fn pipe_runtime() -> io::Result<&'static Runtime> {
    // One reactor for all connections/reconnects. The capture thread can keep
    // using nonblocking poll(), and dropping a client releases its pending I/O.
    static RUNTIME: OnceLock<io::Result<Runtime>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(1)
                .enable_io()
                .thread_name("Axonkey HID pipe IO")
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
        // Match the SDK: GENERIC_READ | FILE_WRITE_DATA. Tokio's write(true)
        // requests GENERIC_WRITE, which also includes FILE_CREATE_PIPE_INSTANCE;
        // the driver's interactive-user ACL deliberately does not grant that.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .access_mode(0x8000_0000 | 0x0002)
            .share_mode(0)
            .custom_flags(0x4000_0000) // FILE_FLAG_OVERLAPPED
            .security_qos_flags(0x10000) // SECURITY_IDENTIFICATION
            .open(path)?;
        // SAFETY: into_raw_handle transfers sole ownership; the overlapped pipe
        // is registered inside the IO runtime. Tokio closes it on errors too.
        let pipe = unsafe { NamedPipeClient::from_raw_handle(file.into_raw_handle()) }?;
        Ok(Self {
            pipe: Some(pipe),
            instance_id: instance_id.into(),
            stage: Stage::Hello,
            descriptor: Err(21), // ERROR_NOT_READY until Hello.
            key_bindings: KeyBindings::default(),
            report_ids: [0; 32],
            frame: Box::new([0; MAX_MESSAGE + 4]),
            offset: 0,
            target: 4,
            started: None,
            key_injection: false,
            next_request: 1,
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
            && self.key_bindings.supports(page, usage, &self.report_ids)
    }

    #[cfg(test)]
    pub(super) fn set_keyboard_fixture(&mut self, usages: &[u16]) {
        self.key_bindings = KeyBindings::keyboard_fixture(usages);
    }

    pub fn send_key(&mut self, page: u16, usage: u16, down: bool) -> io::Result<u64> {
        if !self.key_injection {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Quarbor driver does not support SendKey",
            ));
        }
        self.command(
            proto::client_message::Body::InjectKey(proto::InjectKey {
                usage_page: page.into(),
                usage: usage.into(),
                action: if down { 1 } else { 2 },
                report_id: None,
            }),
            format!(
                "SendKey({page:#06X}, {usage:#06X}, {})",
                if down { "down" } else { "up" }
            ),
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
        let frame = [(bytes.len() as u32).to_le_bytes().to_vec(), bytes].concat();
        self.outgoing.push_back((frame, 0));
        self.pending
            .push_back((request_id, Instant::now(), description));
        log::debug!(target: "axonkey::input", "Quarbor command queued: request_id={request_id}, {}", self.pending.back().unwrap().2);
        // Nonblocking: subsequent poll() calls finish a partially written frame.
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
            // Never reuse a connection after a partial/invalid frame.
            self.pipe = None;
            self.frame.fill(0);
            self.outgoing.clear();
            self.pending.clear();
        }
        result
    }

    fn poll_frame(&mut self) -> io::Result<Option<Event>> {
        if self
            .started
            .is_some_and(|time| time.elapsed() >= FRAME_TIMEOUT)
        {
            return Err(io::Error::from_raw_os_error(1460)); // ERROR_TIMEOUT
        }
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
            if self
                .started
                .is_some_and(|time| time.elapsed() >= FRAME_TIMEOUT)
            {
                return Err(io::Error::from_raw_os_error(1460));
            }
            if self.offset != self.target {
                continue;
            }
            if self.target == 4 {
                let size = u32::from_le_bytes(self.frame[..4].try_into().unwrap()) as usize;
                if !(1..=MAX_MESSAGE).contains(&size) {
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

    fn accept(&mut self, message: proto::ServerMessage) -> io::Result<Event> {
        use proto::server_message::Body;
        if let Some(Body::Result(_)) = &message.body {
            if self.stage != Stage::Reports || message.request_id == 0 {
                return Err(invalid());
            }
            let (id, _, description) = self.pending.pop_front().ok_or_else(invalid)?;
            if id != message.request_id {
                return Err(invalid());
            }
            if message.ntstatus != 0 {
                return Err(io::Error::other(format!(
                    "Quarbor request {id} {description}: NTSTATUS=0x{:08X}",
                    message.ntstatus
                )));
            }
            return Ok(Event::CommandAccepted(id));
        }
        if message.request_id != 0 {
            return Err(invalid());
        }
        let metadata = Metadata {
            sequence: message.report_sequence,
            timestamp: message.timestamp_filetime,
            dropped: message.dropped,
            status: message.ntstatus,
        };
        match (message.body, &self.stage) {
            (Some(Body::Hello(hello)), Stage::Hello) => {
                let id = hello.instance_id;
                if id.is_empty() || id.contains('\0') || id.encode_utf16().count() > 511 {
                    return Err(invalid());
                }
                if !self.instance_id.eq_ignore_ascii_case(&id) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Quarbor Hello device mismatch",
                    ));
                }
                self.descriptor = KeyboardDescriptor::load(&id);
                self.key_bindings = self
                    .descriptor
                    .as_ref()
                    .ok()
                    .and_then(|descriptor| descriptor.key_bindings().ok())
                    .unwrap_or_default();
                self.stage = Stage::Capabilities;
                Ok(Event::Hello(metadata))
            }
            (Some(Body::Capabilities(caps)), Stage::Capabilities) => {
                if !(1..=u16::MAX as u32).contains(&caps.input_report_bytes)
                    || caps.queue_capacity != 64
                {
                    return Err(invalid());
                }
                let report_ids = caps.report_ids.try_into().map_err(|_| invalid())?;
                self.report_ids = report_ids;
                self.key_injection = caps.flags & 2 != 0;
                self.stage = Stage::Reports;
                Ok(Event::Capabilities(Capabilities {
                    input_report_bytes: caps.input_report_bytes,
                    queue_capacity: caps.queue_capacity,
                    flags: caps.flags,
                    report_ids,
                }))
            }
            (Some(Body::Report(report)), Stage::Reports) => {
                if !(1..=MAX_REPORT).contains(&report.report.len()) || metadata.status != 0 {
                    return Err(invalid());
                }
                let usages = match &self.descriptor {
                    Ok(descriptor) => descriptor.usages(&report.report),
                    Err(error) => Err(*error),
                };
                Ok(Event::Report {
                    metadata,
                    bytes: report.report,
                    usages,
                })
            }
            (Some(Body::Status(_)), Stage::Reports) => Ok(Event::Status(metadata)),
            _ => Err(invalid()),
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicU32, Ordering},
            mpsc,
        },
        thread,
        time::{Duration, Instant},
    };
    use tokio::net::windows::named_pipe::ServerOptions;

    const INSTANCE: &str = r"HID\AXONKEY_V3_READ_TEST";
    static NEXT_PIPE: AtomicU32 = AtomicU32::new(0);

    // Reproduce the driver's client rights. Explicitly deny bit 0x4 as well so
    // the test catches GENERIC_WRITE even when run with an administrator token.
    fn restricted_pipe(path: &str) -> tokio::net::windows::named_pipe::NamedPipeServer {
        use std::{ffi::c_void, ptr};
        #[repr(C)]
        struct SecurityAttributes {
            length: u32,
            descriptor: *mut c_void,
            inherit: i32,
        }
        #[link(name = "advapi32")]
        extern "system" {
            fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl: *const u16,
                revision: u32,
                descriptor: *mut *mut c_void,
                size: *mut u32,
            ) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
        }
        let sddl: Vec<u16> = "D:P(D;;0x4;;;WD)(A;;0x12008b;;;WD)"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        // SAFETY: the UTF-16 string is NUL-terminated and both output pointers
        // are valid for this synchronous Windows call.
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    ptr::null_mut(),
                )
            },
            0,
            "{}",
            io::Error::last_os_error()
        );
        let mut attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor,
            inherit: 0,
        };
        // SAFETY: attributes and descriptor stay alive for pipe creation; the
        // kernel captures the descriptor, then LocalFree releases its buffer.
        let pipe = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .create_with_security_attributes_raw(
                    path,
                    (&mut attributes as *mut SecurityAttributes).cast(),
                )
        };
        unsafe {
            LocalFree(descriptor);
        }
        pipe.unwrap()
    }

    fn varint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        while value >= 128 {
            out.push((value as u8 & 127) | 128);
            value >>= 7;
        }
        out.push(value as u8);
        out
    }

    fn bytes_field(tag: u64, bytes: &[u8]) -> Vec<u8> {
        [
            varint(tag * 8 + 2),
            varint(bytes.len() as u64),
            bytes.to_vec(),
        ]
        .concat()
    }

    // Independent schema-based test encoder; production uses prost.
    fn message(tag: u64, body: &[u8], sequence: u64) -> Vec<u8> {
        let mut message = vec![0x11]; // fixed64 timestamp_filetime = field 2
        message.extend_from_slice(&133_000_000_000_000_123u64.to_le_bytes());
        message.extend([vec![0x18], varint(sequence)].concat());
        message.extend(bytes_field(tag, body));
        message.extend([varint(100 * 8), varint(777)].concat()); // unknown ordinary field
        [(message.len() as u32).to_le_bytes().to_vec(), message].concat()
    }

    fn hello(instance: &str) -> Vec<u8> {
        message(20, &bytes_field(1, instance.as_bytes()), 0)
    }

    fn capabilities() -> Vec<u8> {
        let mut body = vec![8, 9, 16, 64, 24, 7];
        body.extend(bytes_field(4, &[0xff; 32]));
        message(23, &body, 0)
    }

    // The server asserts that the reader sends zero bytes, including greetings
    // or per-report acknowledgements. It lives until the Rust reader closes its handle.
    fn server(stream: Vec<u8>, chunk_size: usize) -> (String, thread::JoinHandle<()>) {
        let path = format!(
            r"\\.\pipe\Axonkey.QuarborV3.ReadTest.{}.{}",
            std::process::id(),
            NEXT_PIPE.fetch_add(1, Ordering::Relaxed)
        );
        let server_path = path.clone();
        let (ready, wait_ready) = mpsc::channel();
        let worker = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let pipe = restricted_pipe(&server_path);
                ready.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(5), async {
                    pipe.connect().await.unwrap();
                    for chunk in stream.chunks(chunk_size) {
                        let mut offset = 0;
                        while offset < chunk.len() {
                            pipe.writable().await.unwrap();
                            match pipe.try_write(&chunk[offset..]) {
                                Ok(bytes) => offset += bytes,
                                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                                Err(error)
                                    if matches!(error.raw_os_error(), Some(109 | 232 | 233)) =>
                                {
                                    return
                                }
                                Err(error) => panic!("server write: {error}"),
                            }
                        }
                        if chunk_size < 32 {
                            tokio::time::sleep(Duration::from_millis(2)).await;
                        }
                    }
                    loop {
                        pipe.readable().await.unwrap();
                        match pipe.try_read(&mut [0u8; 64]) {
                            Ok(0) => break,
                            Ok(bytes) => panic!("read-only client sent {bytes} bytes"),
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                            Err(error) if matches!(error.raw_os_error(), Some(109 | 232 | 233)) => {
                                break
                            }
                            Err(error) => panic!("server read: {error}"),
                        }
                    }
                })
                .await
                .expect("server or client stalled");
            });
        });
        wait_ready.recv_timeout(Duration::from_secs(5)).unwrap();
        (path, worker)
    }

    async fn pipe_write(pipe: &tokio::net::windows::named_pipe::NamedPipeServer, bytes: &[u8]) {
        let mut offset = 0;
        while offset < bytes.len() {
            pipe.writable().await.unwrap();
            match pipe.try_write(&bytes[offset..]) {
                Ok(count) => {
                    assert!(count > 0);
                    offset += count;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => panic!("test server write: {error}"),
            }
        }
    }

    async fn pipe_read(pipe: &tokio::net::windows::named_pipe::NamedPipeServer, bytes: &mut [u8]) {
        let mut offset = 0;
        while offset < bytes.len() {
            pipe.readable().await.unwrap();
            match pipe.try_read(&mut bytes[offset..]) {
                Ok(count) => {
                    assert!(count > 0, "client closed mid-command");
                    offset += count;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => panic!("test server read: {error}"),
            }
        }
    }

    pub(crate) fn framed(bytes: Vec<u8>) -> Vec<u8> {
        [(bytes.len() as u32).to_le_bytes().to_vec(), bytes].concat()
    }

    pub(crate) fn key_command(id: u64, page: u64, usage: u64, down: bool) -> Vec<u8> {
        let key = [
            vec![8],
            varint(page),
            vec![16],
            varint(usage),
            vec![24, if down { 1 } else { 2 }],
        ]
        .concat();
        framed([vec![8], varint(id), bytes_field(11, &key)].concat())
    }

    // Independent wire oracle, with physical status frames interleaved between
    // fragmented command responses. No real HID device or OS input is involved.
    pub(crate) fn command_server(
        expected: Vec<Vec<u8>>,
        mode: u8,
    ) -> (String, thread::JoinHandle<()>) {
        let path = format!(
            r"\\.\pipe\Axonkey.QuarborV3.WriteTest.{}.{}",
            std::process::id(),
            NEXT_PIPE.fetch_add(1, Ordering::Relaxed)
        );
        let server_path = path.clone();
        let (ready, wait_ready) = mpsc::channel();
        let worker = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let pipe = restricted_pipe(&server_path);
                ready.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(5), async {
                    pipe.connect().await.unwrap();
                    pipe_write(&pipe, &[hello(INSTANCE), capabilities()].concat()).await;
                    for (index, expected) in expected.iter().enumerate() {
                        let mut actual = vec![0; expected.len()];
                        pipe_read(&pipe, &mut actual).await;
                        assert_eq!(&actual, expected, "command {index}");
                        if mode == 3 {
                            continue;
                        } // no response
                        if mode == 4 {
                            return;
                        } // disconnect after receiving a down
                        pipe_write(&pipe, &message(22, &[], 148)).await;
                        let id = index as u64 + if mode == 2 { 2 } else { 1 };
                        let status: u32 = if mode == 1 { 0xc0000225 } else { 0 };
                        let response = framed(
                            [
                                vec![8],
                                varint(id),
                                vec![0x2d],
                                status.to_le_bytes().to_vec(),
                                bytes_field(24, &[]),
                            ]
                            .concat(),
                        );
                        for chunk in response.chunks(2) {
                            pipe_write(&pipe, chunk).await;
                        }
                    }
                    loop {
                        pipe.readable().await.unwrap();
                        match pipe.try_read(&mut [0; 1]) {
                            Ok(0) => break,
                            Ok(_) => panic!("unexpected extra command"),
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                            Err(error) if matches!(error.raw_os_error(), Some(109 | 232 | 233)) => {
                                break
                            }
                            Err(error) => panic!("waiting for client disconnect: {error}"),
                        }
                    }
                })
                .await
                .expect("duplex test stalled");
            });
        });
        wait_ready.recv_timeout(Duration::from_secs(5)).unwrap();
        (path, worker)
    }

    #[test]
    fn connects_with_sdk_rights_when_generic_write_is_denied() {
        let (path, worker) = command_server(vec![key_command(1, 7, 0xe6, true)], 0);
        {
            let _guard = pipe_runtime().unwrap().enter();
            let error = tokio::net::windows::named_pipe::ClientOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(5)); // ERROR_ACCESS_DENIED
        }
        let mut client = Client::connect_path(&path, INSTANCE).unwrap();
        next(&mut client).unwrap();
        next(&mut client).unwrap();
        client.send_key(7, 0xe6, true).unwrap();
        assert!(matches!(next(&mut client).unwrap(), Event::Status(_)));
        assert!(matches!(
            next(&mut client).unwrap(),
            Event::CommandAccepted(1)
        ));
        drop(client);
        worker.join().unwrap();
    }

    #[test]
    fn sends_ordered_shift_a_edges_and_correlates_interleaved_results() {
        let commands = vec![
            framed(vec![8, 1, 0x62, 0]),
            key_command(2, 7, 0xe1, true),
            key_command(3, 7, 4, true),
            key_command(4, 7, 4, false),
            key_command(5, 7, 0xe1, false),
        ];
        let (path, worker) = command_server(commands, 0);
        let mut client = Client::connect_path(&path, INSTANCE).unwrap();
        next(&mut client).unwrap();
        next(&mut client).unwrap();
        assert_eq!(client.reset_input().unwrap(), 1);
        for (usage, down, id) in [
            (0xe1, true, 2),
            (4, true, 3),
            (4, false, 4),
            (0xe1, false, 5),
        ] {
            assert_eq!(client.send_key(7, usage, down).unwrap(), id);
        }
        for id in 1..=5 {
            assert!(matches!(
                next(&mut client).unwrap(),
                Event::Status(Metadata { sequence: 148, .. })
            ));
            assert!(
                matches!(next(&mut client).unwrap(), Event::CommandAccepted(received) if received == id)
            );
        }
        assert!(client.pending.is_empty());
        drop(client);
        worker.join().unwrap();
    }

    #[test]
    fn rejects_driver_errors_wrong_request_ids_and_disconnects() {
        for mode in [1, 2, 4] {
            let (path, worker) = command_server(vec![key_command(1, 7, 0xe6, true)], mode);
            let mut client = Client::connect_path(&path, INSTANCE).unwrap();
            next(&mut client).unwrap();
            next(&mut client).unwrap();
            client.send_key(7, 0xe6, true).unwrap();
            if mode != 4 {
                assert!(matches!(next(&mut client).unwrap(), Event::Status(_)));
            }
            let error = next(&mut client).unwrap_err();
            if mode == 1 {
                assert!(error.to_string().contains("NTSTATUS=0xC0000225"));
                assert!(error.to_string().contains("0x00E6"));
            }
            assert!(!client.ready());
            drop(client);
            worker.join().unwrap();
        }
    }

    #[test]
    fn bounds_outstanding_commands_times_out_and_requires_key_capability() {
        let expected = (1..=64).map(|id| key_command(id, 7, 4, true)).collect();
        let (path, worker) = command_server(expected, 3);
        let mut client = Client::connect_path(&path, INSTANCE).unwrap();
        next(&mut client).unwrap();
        next(&mut client).unwrap();
        client.key_injection = false;
        assert_eq!(
            client.send_key(7, 4, true).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        client.key_injection = true;
        for _ in 0..64 {
            client.send_key(7, 4, true).unwrap();
        }
        assert_eq!(
            client.send_key(7, 4, true).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        // Wait until the server has read every command before forcing expiration.
        let deadline = Instant::now() + Duration::from_secs(2);
        while !client.outgoing.is_empty() {
            client.poll().unwrap();
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(2));
        }
        // A response deadline also bounds an incomplete write, so either failure
        // closes the connection and invokes the driver's disconnect cleanup.
        client.pending.front_mut().unwrap().1 = Instant::now() - Duration::from_secs(2);
        assert_eq!(client.poll().unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(!client.ready());
        drop(client);
        worker.join().unwrap();
    }

    pub(crate) fn next(reader: &mut Client) -> io::Result<Event> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(event) = reader.poll()? {
                return Ok(event);
            }
            assert!(Instant::now() < deadline, "reader stalled");
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn receives_fragmented_and_coalesced_reports_without_writing() {
        for chunk_size in [3, usize::MAX] {
            let pressed = [3, 0x40, 0, 0x3e, 0, 0, 0, 0, 0];
            let released = [3, 0, 0, 0, 0, 0, 0, 0, 0];
            let stream = [
                hello(INSTANCE),
                capabilities(),
                message(21, &bytes_field(1, &pressed), 42),
                message(21, &bytes_field(1, &released), 43),
                message(22, &[], 43),
            ]
            .concat();
            let (path, worker) = server(stream, chunk_size);
            let mut reader = Client::connect_path(&path, &INSTANCE.to_ascii_lowercase()).unwrap();
            assert!(!reader.ready());
            assert!(matches!(next(&mut reader).unwrap(), Event::Hello(_)));
            assert!(!reader.ready());
            assert!(matches!(
                next(&mut reader).unwrap(),
                Event::Capabilities(Capabilities {
                    input_report_bytes: 9,
                    ..
                })
            ));
            assert!(reader.ready());
            for (sequence, expected) in [(42, &pressed), (43, &released)] {
                let Event::Report {
                    metadata,
                    bytes,
                    usages,
                } = next(&mut reader).unwrap()
                else {
                    panic!("expected raw report")
                };
                assert_eq!(bytes, expected);
                assert_eq!(metadata.sequence, sequence);
                assert_eq!(metadata.timestamp, 133_000_000_000_000_123);
                assert!(
                    usages.is_err(),
                    "fake device has no descriptor; raw data must still arrive"
                );
            }
            assert!(matches!(next(&mut reader).unwrap(), Event::Status(_)));
            drop(reader);
            worker.join().unwrap();
        }
    }

    #[test]
    fn preserves_maximum_hid_payload() {
        let bytes: Vec<_> = (0..4096).map(|index| index as u8).collect();
        let (path, worker) = server(
            [
                hello(INSTANCE),
                capabilities(),
                message(21, &bytes_field(1, &bytes), 1),
            ]
            .concat(),
            usize::MAX,
        );
        let mut reader = Client::connect_path(&path, INSTANCE).unwrap();
        next(&mut reader).unwrap();
        next(&mut reader).unwrap();
        let Event::Report {
            bytes: received, ..
        } = next(&mut reader).unwrap()
        else {
            panic!("expected raw report")
        };
        assert_eq!(received, bytes);
        drop(reader);
        worker.join().unwrap();
    }

    #[test]
    fn rejects_invalid_frames_and_stream_order() {
        let cases = [
            ("zero length", vec![0; 4]),
            ("oversized frame", 8193u32.to_le_bytes().to_vec()),
            ("client direction", message(10, &bytes_field(1, &[1]), 0)),
            ("unknown body", message(26, &[], 0)),
            ("wrong device", hello(r"HID\OTHER_DEVICE")),
            ("NUL in device", hello("HID\\bad\0id")),
            ("missing Hello", capabilities()),
            (
                "repeated Hello",
                [hello(INSTANCE), hello(INSTANCE)].concat(),
            ),
            (
                "missing capabilities",
                [hello(INSTANCE), message(21, &bytes_field(1, &[1]), 1)].concat(),
            ),
            (
                "empty report",
                [
                    hello(INSTANCE),
                    capabilities(),
                    message(21, &bytes_field(1, &[]), 1),
                ]
                .concat(),
            ),
            (
                "oversized report",
                [
                    hello(INSTANCE),
                    capabilities(),
                    message(21, &bytes_field(1, &[0; 4097]), 1),
                ]
                .concat(),
            ),
            ("truncated protobuf", vec![1, 0, 0, 0, 0xff]),
            ("invalid UTF-8", message(20, &bytes_field(1, &[0xff]), 0)),
            ("oversized instance", hello(&"a".repeat(512))),
            (
                "unexpected result",
                [hello(INSTANCE), capabilities(), message(24, &[], 1)].concat(),
            ),
            (
                "zero capability length",
                [hello(INSTANCE), message(23, &[16, 64], 0)].concat(),
            ),
            (
                "invalid capability queue",
                [
                    hello(INSTANCE),
                    message(
                        23,
                        &[vec![8, 9, 16, 63], bytes_field(4, &[0; 32])].concat(),
                        0,
                    ),
                ]
                .concat(),
            ),
            (
                "invalid report ID mask",
                [
                    hello(INSTANCE),
                    message(
                        23,
                        &[vec![8, 9, 16, 64], bytes_field(4, &[0; 31])].concat(),
                        0,
                    ),
                ]
                .concat(),
            ),
        ];
        for (name, bytes) in cases {
            let (path, worker) = server(bytes, usize::MAX);
            let mut reader = Client::connect_path(&path, INSTANCE).unwrap();
            let mut rejected = false;
            for _ in 0..3 {
                if next(&mut reader).is_err() {
                    rejected = true;
                    break;
                }
            }
            assert!(rejected, "accepted invalid stream: {name}");
            drop(reader);
            worker.join().unwrap();
        }
    }

    #[test]
    fn incomplete_frame_times_out_and_pending_read_cancels_on_drop() {
        let (path, worker) = server(vec![5], usize::MAX);
        let mut reader = Client::connect_path(&path, INSTANCE).unwrap();
        assert_eq!(next(&mut reader).unwrap_err().raw_os_error(), Some(1460));
        drop(reader);
        worker.join().unwrap();

        let (path, worker) = server(Vec::new(), usize::MAX);
        let mut reader = Client::connect_path(&path, INSTANCE).unwrap();
        assert!(reader.poll().unwrap().is_none()); // Idle pipe; no report has started.
        thread::sleep(Duration::from_millis(1100)); // Idle connections do not time out.
        assert!(reader.poll().unwrap().is_none());
        let started = Instant::now();
        drop(reader);
        assert!(started.elapsed() < Duration::from_millis(500));
        worker.join().unwrap();
    }

    #[test]
    #[ignore = "requires a connected standard boot keyboard; edits/reads report memory only"]
    fn parses_real_keyboard_descriptor_without_device_input() {
        let instance =
            std::env::var("AXONKEY_HID_TEST_DEVICE").expect("keyboard device instance ID");
        let pressed = [0, 0, 0, 0x3e, 0, 0, 0, 0, 0];
        let released = [0; 9];
        let (path, worker) = server(
            [
                hello(&instance),
                capabilities(),
                message(21, &bytes_field(1, &pressed), 1),
                message(21, &bytes_field(1, &released), 2),
            ]
            .concat(),
            usize::MAX,
        );
        let mut reader = Client::connect_path(&path, &instance).unwrap();
        next(&mut reader).unwrap();
        next(&mut reader).unwrap();
        for expected in [vec![0x3e], vec![]] {
            let Event::Report { usages, .. } = next(&mut reader).unwrap() else {
                panic!("expected report")
            };
            assert_eq!(usages.unwrap(), expected);
        }
        drop(reader);
        worker.join().unwrap();
    }
}
