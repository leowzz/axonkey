//! Local-only byte-stream IPC for the elevated extra-key helper and Gadget.
//! Tokio owns overlapped I/O and its cancellation buffers; the input worker keeps
//! its synchronous, bounded-read interface. No TCP sockets are opened here.
use std::{
    ffi::c_void,
    io::{self, Read, Write},
    os::windows::io::AsRawHandle,
    ptr::null_mut,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::{
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
    runtime::{Builder, Runtime},
    time::timeout,
};

const POLL: Duration = Duration::from_millis(100);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
pub const APP_PIPE_PREFIX: &str = r"\\.\pipe\Axonkey.ExtraKeys.app.";

fn runtime() -> io::Result<&'static Runtime> {
    static RUNTIME: OnceLock<io::Result<Runtime>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(1)
                .thread_name("Axonkey pipe IO")
                .enable_all()
                .build()
        })
        .as_ref()
        .map_err(|error| io::Error::other(error.to_string()))
}

pub fn diagnostic(operation: &str, name: &str, error: &io::Error) -> String {
    format!(
        "本地按键通信失败：{operation} {name}；kind={:?}, os_error={:?}；{error}",
        error.kind(),
        error.raw_os_error()
    )
}

pub fn valid_app_pipe(name: &str) -> bool {
    name.strip_prefix(APP_PIPE_PREFIX)
        .is_some_and(|id| id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit()))
}

pub struct PipeListener {
    name: String,
    pending: NamedPipeServer,
}

impl PipeListener {
    pub fn bind(name: &str) -> io::Result<Self> {
        let began = Instant::now();
        let pending = loop {
            match create_server(name, true) {
                Ok(pipe) => break pipe,
                // Canceled overlapped operations briefly retain the previous
                // handle. Allow rapid disable/re-enable, without taking over
                // another live server or concealing the original error.
                Err(error)
                    if matches!(error.raw_os_error(), Some(5 | 231))
                        && began.elapsed() < Duration::from_secs(1) =>
                {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        };
        Ok(Self {
            name: name.into(),
            pending,
        })
    }

    pub fn accept(&mut self) -> io::Result<PipeStream> {
        runtime()?.block_on(async {
            timeout(POLL, self.pending.connect())
                .await
                .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
        })?;
        // Reserve the next instance before handing over this connection. The
        // name stays owned across reconnects, with no pipe-squatting window.
        let next = create_server(&self.name, false)?;
        let connected = std::mem::replace(&mut self.pending, next);
        Ok(PipeStream::new(Endpoint::Server(connected)))
    }
}

enum Endpoint {
    Server(NamedPipeServer),
    Client(NamedPipeClient),
}

impl Endpoint {
    fn handle(&self) -> *mut c_void {
        match self {
            Self::Server(pipe) => pipe.as_raw_handle(),
            Self::Client(pipe) => pipe.as_raw_handle(),
        }
    }

    async fn ready(&self, write: bool) -> io::Result<()> {
        match (self, write) {
            (Self::Server(pipe), false) => pipe.readable().await,
            (Self::Server(pipe), true) => pipe.writable().await,
            (Self::Client(pipe), false) => pipe.readable().await,
            (Self::Client(pipe), true) => pipe.writable().await,
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        // Mio deliberately lets queued writes outlive its pipe object. On an
        // explicit session close, a peer that stopped reading must not retain
        // that write (and the pipe name) indefinitely. Tokio/Mio still own the
        // overlapped buffers until cancellation completes; never free them here.
        if let Self::Server(pipe) = self {
            let _ = pipe.disconnect();
        }
        unsafe { CancelIoEx(self.handle(), null_mut()) };
    }
}

struct Connection {
    endpoint: Mutex<Option<Arc<Endpoint>>>,
    closed: AtomicBool,
}

#[derive(Clone)]
pub struct PipeStream(Arc<Connection>);

impl PipeStream {
    fn new(endpoint: Endpoint) -> Self {
        Self(Arc::new(Connection {
            endpoint: Mutex::new(Some(Arc::new(endpoint))),
            closed: AtomicBool::new(false),
        }))
    }

    pub fn connect(name: &str, wait: Duration) -> io::Result<Self> {
        let began = Instant::now();
        let _guard = runtime()?.enter();
        loop {
            // SECURITY_ANONYMOUS: even an elevated client must not grant the
            // server impersonation rights. PID verification follows connect.
            match ClientOptions::new().security_qos_flags(0).open(name) {
                Ok(pipe) => return Ok(Self::new(Endpoint::Client(pipe))),
                Err(error)
                    if matches!(error.raw_os_error(), Some(2 | 231)) && began.elapsed() < wait =>
                {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn peer_pid(&self) -> Option<u32> {
        let endpoint = self.0.endpoint.lock().unwrap();
        let mut pid = 0;
        let ok = match endpoint.as_deref()? {
            Endpoint::Server(pipe) => unsafe {
                GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid)
            },
            Endpoint::Client(pipe) => unsafe {
                GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid)
            },
        };
        (ok != 0).then_some(pid)
    }

    pub fn shutdown(&self) {
        let mut endpoint = self.0.endpoint.lock().unwrap();
        self.0.closed.store(true, Ordering::Release);
        // All clones share the close state. In-flight readiness waits release
        // their endpoint within POLL; Tokio then cancels and drains native I/O.
        endpoint.take();
    }

    fn io(
        &self,
        write: bool,
        mut action: impl FnMut(&Endpoint) -> io::Result<usize>,
    ) -> io::Result<usize> {
        let endpoint = self
            .0
            .endpoint
            .lock()
            .unwrap()
            .clone()
            .ok_or(io::ErrorKind::BrokenPipe)?;
        let deadline = Instant::now() + if write { WRITE_TIMEOUT } else { POLL };
        runtime()?.block_on(async {
            loop {
                let result = {
                    // Serialize the start of I/O with shutdown, never its wait.
                    let _guard = self.0.endpoint.lock().unwrap();
                    if self.0.closed.load(Ordering::Acquire) {
                        return Err(io::ErrorKind::BrokenPipe.into());
                    }
                    action(&endpoint)
                };
                match result {
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    result => return result,
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::ErrorKind::TimedOut.into());
                }
                // Idle reads sleep until data arrives. The timer is only a
                // cancellation/health-check bound, never a batching delay.
                if let Ok(result) = timeout(remaining.min(POLL), endpoint.ready(write)).await {
                    result?;
                }
            }
        })
    }
}

impl Read for PipeStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        self.io(false, |endpoint| match endpoint {
            Endpoint::Server(pipe) => pipe.try_read(bytes),
            Endpoint::Client(pipe) => pipe.try_read(bytes),
        })
    }
}

impl Write for PipeStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.io(true, |endpoint| match endpoint {
            Endpoint::Server(pipe) => pipe.try_write(bytes),
            Endpoint::Client(pipe) => pipe.try_write(bytes),
        })
    }

    fn flush(&mut self) -> io::Result<()> {
        // Match Tokio's flush: native writes may still be pending, but there is
        // no extra application buffer. FlushFileBuffers could hang shutdown
        // waiting for the peer; final error delivery is acknowledged by closure.
        Ok(())
    }
}

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}

// CreateFileW also checks FILE_READ_ATTRIBUTES (0x80) when opening a pipe,
// even with Gadget's explicit data read/write + SYNCHRONIZE access mask.
// Only owner/admin/SYSTEM may create instances; LocalService must not receive
// FILE_APPEND_DATA (the same bit as FILE_CREATE_PIPE_INSTANCE).
const PIPE_SDDL: &str = "D:P(A;;FA;;;OW)(A;;FA;;;BA)(A;;FA;;;SY)(A;;0x00100083;;;LS)";

fn create_server(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    create_server_with_security(name, first, PIPE_SDDL)
}

fn create_server_with_security(name: &str, first: bool, sddl: &str) -> io::Result<NamedPipeServer> {
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // Free the descriptor even if runtime initialization or pipe creation fails.
    let result = (|| {
        let _guard = runtime()?.enter();
        let mut attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor,
            inherit: 0,
        };
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .in_buffer_size(65536)
                .out_buffer_size(65536)
                .create_with_security_attributes_raw(
                    name,
                    (&mut attributes as *mut SecurityAttributes).cast(),
                )
        }
    })();
    unsafe { LocalFree(descriptor) };
    result
}

#[link(name = "kernel32")]
extern "system" {
    fn GetNamedPipeClientProcessId(pipe: *mut c_void, pid: *mut u32) -> i32;
    fn GetNamedPipeServerProcessId(pipe: *mut c_void, pid: *mut u32) -> i32;
    fn CancelIoEx(pipe: *mut c_void, overlapped: *mut c_void) -> i32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::{FromRawHandle, IntoRawHandle};
    use std::sync::atomic::AtomicUsize;

    #[repr(C)]
    struct SidAndAttributes {
        sid: *mut c_void,
        attributes: u32,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn ConvertStringSidToSidW(text: *const u16, sid: *mut *mut c_void) -> i32;
        fn CreateRestrictedToken(
            token: *mut c_void,
            flags: u32,
            disable_count: u32,
            disable: *const SidAndAttributes,
            delete_count: u32,
            delete: *const c_void,
            restrict_count: u32,
            restrict: *const SidAndAttributes,
            restricted: *mut *mut c_void,
        ) -> i32;
        fn ImpersonateLoggedOnUser(token: *mut c_void) -> i32;
        fn RevertToSelf() -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
    }

    struct TestHandle(*mut c_void);
    impl Drop for TestHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    struct TestImpersonation;
    impl Drop for TestImpersonation {
        fn drop(&mut self) {
            assert_ne!(unsafe { RevertToSelf() }, 0);
        }
    }

    // Limit the test client to the Users ACE so owner/admin rights cannot mask
    // missing permissions. No UAC or real device host is needed.
    fn restrict_to_client_rights() -> TestImpersonation {
        let mut token = null_mut();
        assert_ne!(
            unsafe { OpenProcessToken(GetCurrentProcess(), 0xa, &mut token) },
            0
        );
        let token = TestHandle(token);
        let text: Vec<u16> = "S-1-5-32-545".encode_utf16().chain(Some(0)).collect();
        let mut sid = null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) },
            0
        );
        let restrict = SidAndAttributes { sid, attributes: 0 };
        let mut restricted = null_mut();
        let result = unsafe {
            CreateRestrictedToken(
                token.0,
                0,
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                1,
                &restrict,
                &mut restricted,
            )
        };
        unsafe { LocalFree(sid) };
        assert_ne!(result, 0);
        let restricted = TestHandle(restricted);
        assert_ne!(unsafe { ImpersonateLoggedOnUser(restricted.0) }, 0);
        TestImpersonation
    }

    #[test]
    fn limited_client_can_exchange_data_but_cannot_create_server_instances() {
        let name = name();
        // Use our ordinary Users identity in place of LocalService for the
        // access check. Keep the production permission masks, then restrict the
        // client token so only this ACE can authorize it.
        let security = PIPE_SDDL.replace(";;;LS)", ";;;BU)");
        let mut listener = PipeListener {
            name: name.clone(),
            pending: create_server_with_security(&name, true, &security).unwrap(),
        };
        let client_name = name.clone();
        let client = thread::spawn(move || {
            let _identity = restrict_to_client_rights();
            let denied = create_server(&client_name, false);
            assert!(
                matches!(denied, Err(error) if error.raw_os_error() == Some(5)),
                "capture clients must not have FILE_CREATE_PIPE_INSTANCE"
            );
            let name: Vec<u16> = client_name.encode_utf16().chain(Some(0)).collect();
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    0x00100003,
                    0,
                    null_mut(),
                    3,
                    0x40100000,
                    null_mut(),
                )
            };
            if handle as isize == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(unsafe { std::fs::File::from_raw_handle(handle) })
            }
        })
        .join()
        .unwrap()
        .expect("limited capture client must connect");
        let mut client = {
            let _guard = runtime().unwrap().enter();
            let pipe =
                unsafe { NamedPipeClient::from_raw_handle(client.into_raw_handle()) }.unwrap();
            PipeStream::new(Endpoint::Client(pipe))
        };
        let mut server = listener.accept().unwrap();
        client.write_all(b"ready").unwrap();
        let mut bytes = [0; 5];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ready");
        server.write_all(b"hello").unwrap();
        client.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"hello");
    }

    fn name() -> String {
        static SERIAL: AtomicUsize = AtomicUsize::new(0);
        format!(
            r"\\.\pipe\Axonkey.ExtraKeys.test.{}.{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn pair() -> (PipeListener, PipeStream, PipeStream) {
        let name = name();
        let mut listener = PipeListener::bind(&name).unwrap();
        let client = PipeStream::connect(&name, Duration::from_secs(1)).unwrap();
        let server = listener.accept().unwrap();
        (listener, client, server)
    }

    fn assert_disconnected(client: &mut PipeStream) {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            match client.read(&mut [0; 8]) {
                Ok(0) => return,
                Err(error)
                    if error.kind() == io::ErrorKind::BrokenPipe
                        || matches!(error.raw_os_error(), Some(109 | 232 | 233)) =>
                {
                    return
                }
                Err(error) if error.kind() == io::ErrorKind::TimedOut => {
                    assert!(Instant::now() < deadline, "peer remained connected");
                }
                result => panic!("expected pipe closure, got {result:?}"),
            }
        }
    }

    #[test]
    fn helper_accepts_only_its_local_application_namespace() {
        let name = format!("{APP_PIPE_PREFIX}{}", "a".repeat(64));
        assert!(valid_app_pipe(&name));
        assert!(!valid_app_pipe(&name.replace(r"\\.\", r"\\remote\")));
        assert!(!valid_app_pipe(&name.replace("app.", "gadget.")));
        assert!(!valid_app_pipe(&format!("{name}\\extra")));
        assert!(!valid_app_pipe(&format!("{APP_PIPE_PREFIX}short")));
    }

    #[test]
    fn listener_reserves_name_across_timeouts_connections_and_reconnects() {
        let name = name();
        let mut listener = PipeListener::bind(&name).unwrap();
        assert!(PipeListener::bind(&name).is_err());
        assert!(matches!(listener.accept(), Err(e) if e.kind() == io::ErrorKind::TimedOut));
        for _ in 0..3 {
            let mut client = PipeStream::connect(&name, Duration::from_secs(1)).unwrap();
            let mut server = listener.accept().unwrap();
            assert_eq!(client.peer_pid(), Some(std::process::id()));
            assert_eq!(server.peer_pid(), Some(std::process::id()));
            assert!(PipeListener::bind(&name).is_err());
            client.write_all(b"press").unwrap();
            let mut bytes = [0; 5];
            server.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"press");
            server.write_all(b"reply").unwrap();
            client.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"reply");
            server.shutdown();
            assert_disconnected(&mut client);
        }
        drop(listener);
        assert!(
            PipeListener::bind(&name).is_ok(),
            "no stale name after exit"
        );
    }

    #[test]
    fn shutdown_interrupts_idle_read_and_closes_all_clones() {
        let (_listener, mut client, mut server) = pair();
        let control = server.clone();
        let reader = thread::spawn(move || server.read(&mut [0; 8]));
        thread::sleep(Duration::from_millis(20));
        let began = Instant::now();
        control.shutdown();
        assert!(reader.join().unwrap().is_err());
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(control.clone().write(b"late").is_err());
        // A retained control clone must not keep the peer connected.
        assert_disconnected(&mut client);
    }

    #[test]
    fn shutdown_interrupts_a_write_when_the_peer_stops_reading() {
        let (_listener, _client, mut server) = pair();
        let control = server.clone();
        let writer = thread::spawn(move || {
            // Mio can enqueue the first buffer before native I/O completes.
            // The next write must wait while the unread pipe is full.
            server.write_all(&vec![0; 4 * 1024 * 1024])?;
            server.write_all(b"blocked")
        });
        thread::sleep(Duration::from_millis(50));
        let began = Instant::now();
        control.shutdown();
        assert!(writer.join().unwrap().is_err());
        assert!(began.elapsed() < Duration::from_secs(1));
    }
}
