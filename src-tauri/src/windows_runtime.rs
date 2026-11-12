use std::{
    marker::PhantomData,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard, OnceLock, TryLockError,
    },
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::{Error, Result, RuntimeType, HRESULT},
    Win32::System::Com::{
        CoIncrementMTAUsage, CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
    },
};
use windows_future::{AsyncStatus, IAsyncOperation};

pub(crate) struct MtaApartment(PhantomData<*mut ()>);

fn bluetooth_calls() -> &'static Mutex<()> {
    static BLUETOOTH_CALLS: OnceLock<Mutex<()>> = OnceLock::new();
    BLUETOOTH_CALLS.get_or_init(|| Mutex::new(()))
}

pub(crate) struct BluetoothRequest<'a> {
    deadline: Instant,
    stop: Option<&'a AtomicBool>,
}

impl<'a> BluetoothRequest<'a> {
    pub(crate) fn new(timeout: Duration, stop: Option<&'a AtomicBool>) -> Self {
        Self {
            deadline: Instant::now() + timeout,
            stop,
        }
    }

    pub(crate) fn run<T: RuntimeType + 'static>(
        &self,
        stage: &str,
        start: impl FnOnce() -> Result<IAsyncOperation<T>>,
    ) -> Result<T> {
        let started = Instant::now();
        let mut lock_wait = Duration::ZERO;
        let mut initiation = Duration::ZERO;
        let result = (|| {
            let guard = self.acquire(stage);
            lock_wait = started.elapsed();
            let guard = guard?;
            self.check(stage)?;
            let initiating = Instant::now();
            let operation = start();
            initiation = initiating.elapsed();
            // Only WinRT operation creation is serialized. Bluetooth I/O must
            // release this guard so another remote can make progress.
            drop(guard);
            let operation = operation?;
            loop {
                if let Err(error) = self.check(stage) {
                    let _ = operation.Cancel();
                    return Err(error);
                }
                match operation.Status() {
                    Ok(AsyncStatus::Started) => self.wait(),
                    Ok(_) => return operation.GetResults(),
                    Err(error) => {
                        let _ = operation.Cancel();
                        return Err(error);
                    }
                }
            }
        })();
        let elapsed = started.elapsed();
        let operation_wait = elapsed.saturating_sub(lock_wait + initiation);
        if result
            .as_ref()
            .is_err_and(|error| error.code() == HRESULT(0x800705b4u32 as i32))
        {
            log::warn!(target: "axonkey::bluetooth",
                "{stage}: Bluetooth request timed out; lock_wait_ms={}, initiation_ms={}, operation_ms={}, total_ms={}",
                lock_wait.as_millis(), initiation.as_millis(),
                operation_wait.as_millis(), elapsed.as_millis());
        }
        log::debug!(target: "axonkey::bluetooth",
            "{stage}: lock_wait_ms={}, initiation_ms={}, operation_ms={}, total_ms={}",
            lock_wait.as_millis(), initiation.as_millis(),
            operation_wait.as_millis(), elapsed.as_millis());
        result
    }

    fn acquire(&self, stage: &str) -> Result<MutexGuard<'static, ()>> {
        loop {
            self.check(stage)?;
            match bluetooth_calls().try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
                Err(TryLockError::WouldBlock) => self.wait(),
            }
        }
    }

    fn check(&self, stage: &str) -> Result<()> {
        if self.stop.is_some_and(|stop| stop.load(Ordering::Acquire)) {
            return Err(Error::new(
                HRESULT(0x800704c7u32 as i32),
                format!("{stage} 已取消"),
            ));
        }
        if Instant::now() >= self.deadline {
            return Err(Error::new(
                HRESULT(0x800705b4u32 as i32),
                format!("{stage} 超时"),
            ));
        }
        Ok(())
    }

    fn wait(&self) {
        thread::sleep(
            Duration::from_millis(10).min(self.deadline.saturating_duration_since(Instant::now())),
        );
    }
}

pub(crate) fn initialize_mta() -> Result<MtaApartment> {
    static MTA: OnceLock<std::result::Result<(), HRESULT>> = OnceLock::new();
    // windows-rs caches WinRT factories for the process. Keep their MTA alive
    // when the last Bluetooth worker uninitializes COM between queries. This
    // process reference intentionally lasts until exit, just like the cache.
    (*MTA.get_or_init(|| {
        unsafe { CoIncrementMTAUsage() }
            .map(|_| ())
            .map_err(|e| e.code())
    }))
    .map_err(Error::from_hresult)?;
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    Ok(MtaApartment(PhantomData))
}

impl Drop for MtaApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc};
    use windows::core::{implement, Ref};
    use windows_future::{
        AsyncOperationCompletedHandler, IAsyncInfo, IAsyncInfo_Impl, IAsyncOperation_Impl,
    };

    #[implement(IAsyncOperation<u32>, IAsyncInfo)]
    struct PendingOperation {
        canceled: Arc<AtomicBool>,
        results: Arc<AtomicUsize>,
    }

    impl IAsyncInfo_Impl for PendingOperation_Impl {
        fn Id(&self) -> Result<u32> {
            Ok(1)
        }
        fn Status(&self) -> Result<AsyncStatus> {
            Ok(if self.canceled.load(Ordering::Acquire) {
                AsyncStatus::Canceled
            } else {
                AsyncStatus::Started
            })
        }
        fn ErrorCode(&self) -> Result<HRESULT> {
            Ok(HRESULT(0))
        }
        fn Cancel(&self) -> Result<()> {
            self.canceled.store(true, Ordering::Release);
            Ok(())
        }
        fn Close(&self) -> Result<()> {
            Ok(())
        }
    }

    impl IAsyncOperation_Impl<u32> for PendingOperation_Impl {
        fn SetCompleted(&self, _: Ref<'_, AsyncOperationCompletedHandler<u32>>) -> Result<()> {
            Ok(())
        }
        fn Completed(&self) -> Result<AsyncOperationCompletedHandler<u32>> {
            Err(Error::empty())
        }
        fn GetResults(&self) -> Result<u32> {
            self.results.fetch_add(1, Ordering::Relaxed);
            Err(Error::from_hresult(HRESULT(0x8000000eu32 as i32)))
        }
    }

    #[test]
    fn ready_operations_return_values_and_original_errors() {
        let request = BluetoothRequest::new(Duration::from_secs(1), None);
        assert_eq!(
            request
                .run("ready", || Ok(IAsyncOperation::ready(Ok(42))))
                .unwrap(),
            42
        );
        let code = HRESULT(0x80070005u32 as i32);
        let result = request.run::<u32>("error", || {
            Ok(IAsyncOperation::ready(Err(Error::from_hresult(code))))
        });
        assert_eq!(result.unwrap_err().code(), code);
    }

    #[test]
    fn operation_wait_releases_the_bluetooth_guard() {
        let request = BluetoothRequest::new(Duration::from_secs(2), None);
        let result = request.run("spawn", || {
            Ok(IAsyncOperation::spawn(|| {
                let _guard = bluetooth_calls().lock().unwrap();
                Ok(54u32)
            }))
        });
        assert_eq!(result.unwrap(), 54);
    }

    #[test]
    fn timeout_cancels_pending_operation_without_reading_its_results() {
        let canceled = Arc::new(AtomicBool::new(false));
        let results = Arc::new(AtomicUsize::new(0));
        let operation: IAsyncOperation<u32> = PendingOperation {
            canceled: canceled.clone(),
            results: results.clone(),
        }
        .into();
        let request = BluetoothRequest::new(Duration::from_millis(30), None);
        let result = request.run("pending", || Ok(operation));
        assert_eq!(result.unwrap_err().code(), HRESULT(0x800705b4u32 as i32));
        assert!(canceled.load(Ordering::Acquire));
        assert_eq!(results.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn stop_cancels_an_inflight_operation_and_prevents_later_initiation() {
        let stop = Arc::new(AtomicBool::new(false));
        let canceled = Arc::new(AtomicBool::new(false));
        let operation: IAsyncOperation<u32> = PendingOperation {
            canceled: canceled.clone(),
            results: Arc::new(AtomicUsize::new(0)),
        }
        .into();
        let request = BluetoothRequest::new(Duration::from_secs(2), Some(&stop));
        let result = request.run("stopping", || {
            stop.store(true, Ordering::Release);
            Ok(operation)
        });
        assert_eq!(result.unwrap_err().code(), HRESULT(0x800704c7u32 as i32));
        assert!(canceled.load(Ordering::Acquire));
        assert!(request
            .run::<u32>("stopped", || panic!("must not initiate"))
            .is_err());
    }

    #[test]
    fn consecutive_operations_share_the_same_deadline() {
        let request = BluetoothRequest::new(Duration::from_millis(30), None);
        request
            .run("first", || Ok(IAsyncOperation::ready(Ok(1u32))))
            .unwrap();
        thread::sleep(Duration::from_millis(40));
        let result = request.run::<u32>("expired", || panic!("must not initiate"));
        assert_eq!(result.unwrap_err().code(), HRESULT(0x800705b4u32 as i32));
    }

    #[test]
    fn canceled_request_does_not_wait_for_another_call_to_release_the_guard() {
        let _guard = bluetooth_calls().lock().unwrap();
        let stop = AtomicBool::new(true);
        let request = BluetoothRequest::new(Duration::from_secs(1), Some(&stop));
        let result =
            request.run::<u32>("canceled before initiation", || panic!("must not initiate"));
        assert_eq!(result.unwrap_err().code(), HRESULT(0x800704c7u32 as i32));
    }
}
