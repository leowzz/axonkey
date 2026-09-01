use super::{atvv::AtvvDecoder, clamp_gain_db, AudioServiceStatus};
use std::{
    ffi::{c_char, c_void},
    sync::{
        atomic::{AtomicPtr, Ordering},
        Arc, Mutex,
    },
};

const EVENT_AUDIO_PACKET: i32 = 1;
const EVENT_CODEC_SYNC: i32 = 2;
const EVENT_SESSION_START: i32 = 3;
const EVENT_SESSION_STOP: i32 = 4;

type EventCallback = unsafe extern "C" fn(*mut c_void, i32, *const u8, usize, i32, i32);

#[repr(C)]
struct NativeCallbacks {
    context: *mut c_void,
    on_event: EventCallback,
}

extern "C" {
    fn axonkey_macos_audio_create(callbacks: *const NativeCallbacks) -> *mut c_void;
    fn axonkey_macos_audio_start(bridge: *mut c_void);
    fn axonkey_macos_audio_refresh(bridge: *mut c_void);
    fn axonkey_macos_audio_stop(bridge: *mut c_void);
    fn axonkey_macos_audio_destroy(bridge: *mut c_void);
    fn axonkey_macos_audio_driver_installed() -> bool;
    fn axonkey_macos_audio_state(bridge: *mut c_void) -> i32;
    fn axonkey_macos_audio_bluetooth_connected(bridge: *mut c_void) -> bool;
    fn axonkey_macos_audio_forwarding(bridge: *mut c_void) -> bool;
    fn axonkey_macos_audio_battery_level(bridge: *mut c_void) -> i32;
    fn axonkey_macos_audio_copy_error(
        bridge: *mut c_void,
        buffer: *mut c_char,
        capacity: usize,
    ) -> usize;
    fn axonkey_macos_audio_enqueue(bridge: *mut c_void, samples: *const i16, count: usize) -> bool;
    fn axonkey_macos_audio_set_gain_db(bridge: *mut c_void, gain_db: f32);
}

struct Shared {
    bridge: AtomicPtr<c_void>,
    decoder: Mutex<AtvvDecoder>,
}

pub struct AudioService {
    shared: Arc<Shared>,
    callback_context: *const Shared,
}

unsafe impl Send for AudioService {}
unsafe impl Sync for AudioService {}

impl AudioService {
    pub fn start() -> Self {
        log::info!(target: "axonkey::audio", "Starting macOS audio service");
        let shared = Arc::new(Shared {
            bridge: AtomicPtr::new(std::ptr::null_mut()),
            decoder: Mutex::new(AtvvDecoder::default()),
        });
        let callback_context = Arc::into_raw(Arc::clone(&shared));
        let callbacks = NativeCallbacks {
            context: callback_context.cast_mut().cast(),
            on_event: native_event_callback,
        };
        let bridge = unsafe { axonkey_macos_audio_create(&callbacks) };
        shared.bridge.store(bridge, Ordering::Release);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_start(bridge) };
            log::info!(target: "axonkey::audio", "macOS audio bridge started");
        } else {
            log::error!(target: "axonkey::audio", "Cannot create the macOS audio bridge");
        }
        Self {
            shared,
            callback_context,
        }
    }

    pub fn refresh(&self) {
        log::debug!(target: "axonkey::audio", "Refreshing macOS audio state");
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_refresh(bridge) };
        }
    }

    pub fn pause(&self) {
        log::info!(target: "axonkey::audio", "Pausing macOS audio bridge");
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_stop(bridge) };
        }
    }

    pub fn resume(&self) {
        log::info!(target: "axonkey::audio", "Resuming macOS audio bridge");
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_start(bridge) };
        }
    }

    pub fn set_gain_db(&self, gain: i16) -> Result<(), String> {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            log::error!(target: "axonkey::audio", "Cannot set audio gain because the macOS bridge is unavailable");
            return Err("无法连接 macOS 音频服务".into());
        }
        let gain_db = clamp_gain_db(gain);
        log::info!(target: "axonkey::audio", "Updating audio gain to {gain_db} dB");
        unsafe { axonkey_macos_audio_set_gain_db(bridge, f32::from(gain_db)) };
        Ok(())
    }

    pub fn status(&self) -> AudioServiceStatus {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
            log::error!(target: "axonkey::audio", "Cannot read macOS audio status because the bridge is unavailable");
            return AudioServiceStatus {
                driver_installed: unsafe { axonkey_macos_audio_driver_installed() },
                state: "error".into(),
                error: Some("Cannot create the macOS audio bridge".into()),
                ..AudioServiceStatus::default()
            };
        }
        let state_code = unsafe { axonkey_macos_audio_state(bridge) };
        AudioServiceStatus {
            driver_installed: unsafe { axonkey_macos_audio_driver_installed() },
            state: state_name(state_code).into(),
            bluetooth_connected: unsafe { axonkey_macos_audio_bluetooth_connected(bridge) },
            forwarding: unsafe { axonkey_macos_audio_forwarding(bridge) },
            battery_level: battery_level_from_native(unsafe {
                axonkey_macos_audio_battery_level(bridge)
            }),
            error: native_error(bridge),
        }
    }
}

impl Drop for AudioService {
    fn drop(&mut self) {
        let bridge = self
            .shared
            .bridge
            .swap(std::ptr::null_mut(), Ordering::AcqRel);
        if !bridge.is_null() {
            unsafe {
                axonkey_macos_audio_stop(bridge);
                axonkey_macos_audio_destroy(bridge);
            }
        }
        unsafe { drop(Arc::from_raw(self.callback_context)) };
    }
}

fn state_name(code: i32) -> &'static str {
    match code {
        0 => "stopped",
        1 => "driverMissing",
        2 => "bluetoothUnavailable",
        3 => "scanning",
        4 => "connecting",
        5 => "ready",
        6 => "forwarding",
        7 => "error",
        _ => "unknown",
    }
}

fn battery_level_from_native(level: i32) -> Option<u8> {
    u8::try_from(level).ok().filter(|level| *level <= 100)
}

fn native_error(bridge: *mut c_void) -> Option<String> {
    let mut buffer = vec![0_i8; 512];
    let length =
        unsafe { axonkey_macos_audio_copy_error(bridge, buffer.as_mut_ptr(), buffer.len()) };
    if length == 0 {
        return None;
    }
    let bytes = buffer
        .iter()
        .take(length.min(buffer.len().saturating_sub(1)))
        .map(|value| *value as u8)
        .collect::<Vec<_>>();
    String::from_utf8(bytes)
        .ok()
        .filter(|value| !value.is_empty())
}

unsafe extern "C" fn native_event_callback(
    context: *mut c_void,
    event: i32,
    data: *const u8,
    length: usize,
    value1: i32,
    value2: i32,
) {
    if context.is_null() {
        return;
    }
    let shared = &*(context.cast::<Shared>());
    let Ok(mut decoder) = shared.decoder.lock() else {
        return;
    };
    match event {
        EVENT_AUDIO_PACKET if !data.is_null() && length > 0 => {
            let packet = std::slice::from_raw_parts(data, length);
            let frames = decoder.append(packet, value1.max(1) as usize);
            drop(decoder);
            let bridge = shared.bridge.load(Ordering::Acquire);
            if bridge.is_null() {
                return;
            }
            for samples in frames {
                let _ = axonkey_macos_audio_enqueue(bridge, samples.as_ptr(), samples.len());
            }
        }
        EVENT_CODEC_SYNC => decoder.synchronize(value1, value2),
        EVENT_SESSION_START | EVENT_SESSION_STOP => decoder.reset_session(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::battery_level_from_native;

    #[test]
    fn accepts_only_valid_native_battery_percentages() {
        assert_eq!(battery_level_from_native(-1), None);
        assert_eq!(battery_level_from_native(0), Some(0));
        assert_eq!(battery_level_from_native(100), Some(100));
        assert_eq!(battery_level_from_native(101), None);
    }
}
