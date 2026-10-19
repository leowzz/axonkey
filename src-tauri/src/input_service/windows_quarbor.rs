//! Read-only v3 pipe transport implemented entirely in Rust.
use super::windows_hid::KeyboardDescriptor;
use prost::Message;
use std::{
    io,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::{
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
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
}

#[derive(PartialEq)]
enum Stage {
    Hello,
    Capabilities,
    Reports,
}

pub(super) struct Reader {
    pipe: Option<NamedPipeClient>,
    instance_id: String,
    stage: Stage,
    descriptor: Result<KeyboardDescriptor, u32>,
    frame: Box<[u8; MAX_MESSAGE + 4]>,
    offset: usize,
    target: usize,
    started: Option<Instant>,
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
    io::Error::new(io::ErrorKind::InvalidData, "invalid Quarbor v3 read stream")
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

impl Reader {
    pub fn connect(instance_id: &str) -> io::Result<Self> {
        Self::connect_path(&pipe_name(instance_id), instance_id)
    }

    fn connect_path(path: &str, instance_id: &str) -> io::Result<Self> {
        let _guard = pipe_runtime()?.enter();
        let pipe = ClientOptions::new()
            .read(true)
            .write(false)
            .security_qos_flags(0x10000) // SECURITY_IDENTIFICATION
            .open(path)?;
        Ok(Self {
            pipe: Some(pipe),
            instance_id: instance_id.into(),
            stage: Stage::Hello,
            descriptor: Err(21), // ERROR_NOT_READY until Hello.
            frame: Box::new([0; MAX_MESSAGE + 4]),
            offset: 0,
            target: 4,
            started: None,
        })
    }

    pub fn ready(&self) -> bool {
        self.pipe.is_some() && self.stage == Stage::Reports
    }

    pub fn poll(&mut self) -> io::Result<Option<Event>> {
        let result = self.poll_frame();
        if result.is_err() {
            // Never reuse a connection after a partial/invalid frame.
            self.pipe = None;
            self.frame.fill(0);
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
        // This connection never issues commands, so no correlated response is valid.
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
mod tests {
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
                let pipe = ServerOptions::new()
                    .first_pipe_instance(true)
                    .create(&server_path)
                    .unwrap();
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

    fn next(reader: &mut Reader) -> io::Result<Event> {
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
            let mut reader = Reader::connect_path(&path, &INSTANCE.to_ascii_lowercase()).unwrap();
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
        let mut reader = Reader::connect_path(&path, INSTANCE).unwrap();
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
            let mut reader = Reader::connect_path(&path, INSTANCE).unwrap();
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
        let mut reader = Reader::connect_path(&path, INSTANCE).unwrap();
        assert_eq!(next(&mut reader).unwrap_err().raw_os_error(), Some(1460));
        drop(reader);
        worker.join().unwrap();

        let (path, worker) = server(Vec::new(), usize::MAX);
        let mut reader = Reader::connect_path(&path, INSTANCE).unwrap();
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
        let mut reader = Reader::connect_path(&path, &instance).unwrap();
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
