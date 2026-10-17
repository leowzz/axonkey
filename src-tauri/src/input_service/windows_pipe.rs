//! Local-only byte-stream IPC for Quarbor HID reports.
//! Tokio owns overlapped I/O and its cancellation buffers; the input worker keeps
//! its synchronous, bounded-read interface. No TCP sockets are opened here.
use std::{
    ffi::c_void,
    io::{self, Read},
    os::windows::io::AsRawHandle,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::{
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    runtime::{Builder, Runtime},
    time::timeout,
};

const POLL: Duration = Duration::from_millis(100);

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

enum Endpoint {
    Client(NamedPipeClient),
}

impl Endpoint {
    fn handle(&self) -> *mut c_void {
        match self {
            Self::Client(pipe) => pipe.as_raw_handle(),
        }
    }

    async fn ready(&self) -> io::Result<()> {
        match self {
            Self::Client(pipe) => pipe.readable().await,
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        unsafe { CancelIoEx(self.handle(), std::ptr::null_mut()) };
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

    /// Connect to the producer-only Quarbor pipe with read access.
    pub fn connect_read_only(name: &str, wait: Duration) -> io::Result<Self> {
        let began = Instant::now();
        let _guard = runtime()?.enter();
        loop {
            let mut options = ClientOptions::new();
            options.read(true).write(false);
            match options.open(name) {
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

    fn io(&self, mut action: impl FnMut(&Endpoint) -> io::Result<usize>) -> io::Result<usize> {
        let endpoint = self
            .0
            .endpoint
            .lock()
            .unwrap()
            .clone()
            .ok_or(io::ErrorKind::BrokenPipe)?;
        let deadline = Instant::now() + POLL;
        runtime()?.block_on(async {
            loop {
                let result = {
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
                if let Ok(result) = timeout(remaining, endpoint.ready()).await {
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
        self.io(|endpoint| match endpoint {
            Endpoint::Client(pipe) => pipe.try_read(bytes),
        })
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn CancelIoEx(pipe: *mut c_void, overlapped: *mut c_void) -> i32;
}
