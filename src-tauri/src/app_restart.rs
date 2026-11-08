pub async fn restart_after_shutdown(
    shutdown: impl FnOnce() + Send + 'static,
    restart: impl FnOnce() + Send + 'static,
) -> Result<(), String> {
    // The device worker synchronously queries macOS audio on the main thread.
    // Join it before requesting exit, while that thread still processes tasks.
    tauri::async_runtime::spawn_blocking(move || {
        shutdown();
        restart();
    })
    .await
    .map_err(|error| format!("无法关闭设备服务并重启：{error}"))
}

#[cfg(test)]
mod tests {
    use super::restart_after_shutdown;
    use std::{
        future::Future,
        sync::mpsc,
        task::{Context, Poll, Waker},
        thread,
        time::Duration,
    };

    #[test]
    fn restart_keeps_the_calling_thread_free_until_device_shutdown_finishes() {
        let main_thread = thread::current().id();
        let (request, requests) = mpsc::channel();
        let (reply, replies) = mpsc::channel();
        let (restart, restarted) = mpsc::channel();
        let mut task = Box::pin(restart_after_shutdown(
            move || {
                assert_ne!(thread::current().id(), main_thread);
                request.send(()).unwrap();
                replies.recv_timeout(Duration::from_secs(2)).unwrap();
            },
            move || restart.send(()).unwrap(),
        ));

        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(task.as_mut().poll(&mut context), Poll::Pending));
        requests.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(restarted.try_recv().is_err());
        // Service the native worker's main-thread request before it can exit.
        reply.send(()).unwrap();
        tauri::async_runtime::block_on(task).unwrap();
        restarted.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn shutdown_failure_does_not_restart_the_app() {
        let (restart, restarted) = mpsc::channel();
        let result = tauri::async_runtime::block_on(restart_after_shutdown(
            || panic!("shutdown failed"),
            move || restart.send(()).unwrap(),
        ));
        assert!(result.is_err());
        assert!(restarted.try_recv().is_err());
    }
}
