use super::AudioServiceStatus;
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
        }
        Self {
            shared,
            callback_context,
        }
    }

    pub fn refresh(&self) {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_refresh(bridge) };
        }
    }

    pub fn pause(&self) {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_stop(bridge) };
        }
    }

    pub fn resume(&self) {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if !bridge.is_null() {
            unsafe { axonkey_macos_audio_start(bridge) };
        }
    }

    pub fn status(&self) -> AudioServiceStatus {
        let bridge = self.shared.bridge.load(Ordering::Acquire);
        if bridge.is_null() {
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

#[derive(Default)]
struct AtvvDecoder {
    pending: Vec<u8>,
    predictor: i32,
    step_index: i32,
    pending_sync: Option<(i32, i32)>,
}

impl AtvvDecoder {
    fn reset_session(&mut self) {
        self.pending.clear();
        self.predictor = 0;
        self.step_index = 0;
        self.pending_sync = None;
    }

    fn synchronize(&mut self, predictor: i32, step_index: i32) {
        self.pending.clear();
        self.pending_sync = Some((predictor, step_index));
    }

    fn append(&mut self, packet: &[u8], frame_size: usize) -> Vec<Vec<i16>> {
        self.pending.extend_from_slice(packet);
        let frame_count = self.pending.len() / frame_size;
        if frame_count == 0 {
            return Vec::new();
        }
        let consumed = frame_count * frame_size;
        let bytes = self.pending.drain(..consumed).collect::<Vec<_>>();
        bytes
            .chunks_exact(frame_size)
            .map(|frame| {
                if let Some((predictor, step_index)) = self.pending_sync.take() {
                    self.predictor = predictor.clamp(i16::MIN as i32, i16::MAX as i32);
                    self.step_index = step_index.clamp(0, 88);
                }
                let samples = self.decode(frame);
                smooth(samples)
            })
            .collect()
    }

    fn decode(&mut self, data: &[u8]) -> Vec<i16> {
        let mut samples = Vec::with_capacity(data.len() * 2);
        for byte in data {
            samples.push(self.decode_nibble((byte >> 4) as i32));
            samples.push(self.decode_nibble((byte & 0x0f) as i32));
        }
        samples
    }

    fn decode_nibble(&mut self, nibble: i32) -> i16 {
        const STEP_TABLE: [i32; 89] = [
            7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55,
            60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
            337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
            1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
            5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
            20350, 22385, 24623, 27086, 29794, 32767,
        ];
        const INDEX_TABLE: [i32; 8] = [-1, -1, -1, -1, 2, 4, 6, 8];

        let step = STEP_TABLE[self.step_index as usize];
        let mut difference = step >> 3;
        if nibble & 1 != 0 {
            difference += step >> 2;
        }
        if nibble & 2 != 0 {
            difference += step >> 1;
        }
        if nibble & 4 != 0 {
            difference += step;
        }
        self.predictor += if nibble & 8 != 0 {
            -difference
        } else {
            difference
        };
        self.predictor = self.predictor.clamp(i16::MIN as i32, i16::MAX as i32);
        self.step_index = (self.step_index + INDEX_TABLE[(nibble & 7) as usize]).clamp(0, 88);
        self.predictor as i16
    }
}

fn smooth(mut samples: Vec<i16>) -> Vec<i16> {
    if samples.len() < 3 {
        return samples;
    }
    let source = samples.clone();
    for index in 1..(samples.len() - 1) {
        samples[index] = ((i32::from(source[index - 1])
            + 2 * i32::from(source[index])
            + i32::from(source[index + 1]))
            >> 2) as i16;
    }
    samples
}

#[cfg(test)]
mod tests {
    use super::{battery_level_from_native, smooth, AtvvDecoder};

    #[test]
    fn accepts_only_valid_native_battery_percentages() {
        assert_eq!(battery_level_from_native(-1), None);
        assert_eq!(battery_level_from_native(0), Some(0));
        assert_eq!(battery_level_from_native(100), Some(100));
        assert_eq!(battery_level_from_native(101), None);
    }

    #[test]
    fn decoder_uses_rc003_high_nibble_order() {
        let mut decoder = AtvvDecoder::default();
        assert_eq!(decoder.decode(&[0x11]), vec![1, 2]);
        decoder.reset_session();
        assert_eq!(decoder.decode(&[0x7f]), vec![11, -19]);
    }

    #[test]
    fn accumulator_preserves_partial_frames() {
        let mut decoder = AtvvDecoder::default();
        assert!(decoder.append(&[0x11, 0x22], 3).is_empty());
        assert_eq!(decoder.pending, vec![0x11, 0x22]);
        let frames = decoder.append(&[0x33, 0x44, 0x55, 0x66, 0x77], 3);
        assert_eq!(frames.len(), 2);
        assert_eq!(decoder.pending, vec![0x77]);
    }

    #[test]
    fn smoothing_uses_neighbor_weighting() {
        assert_eq!(smooth(vec![0, 1000, 0]), vec![0, 500, 0]);
    }

    #[test]
    fn codec_sync_clamps_decoder_state() {
        let mut decoder = AtvvDecoder::default();
        decoder.synchronize(100_000, 1_000);
        let _ = decoder.append(&[0x00], 1);
        assert_eq!(decoder.predictor, i16::MAX as i32);
        assert_eq!(decoder.step_index, 86);
    }
}
