//! Fixed-size G.722.1/Siren7 decoder. Upstream global DSP/bit-reader state is serialized.
use std::{ffi::c_void, ptr::NonNull, sync::Mutex};

static CODEC_LOCK: Mutex<()> = Mutex::new(());

extern "C" {
    fn Siren7_NewDecoder(sample_rate: i32) -> *mut c_void;
    fn Siren7_CloseDecoder(decoder: *mut c_void);
    #[cfg(test)]
    fn Siren7_DecodeFrame(decoder: *mut c_void, input: *mut u8, output: *mut u8) -> i32;
    fn Siren7_DecodeG7221Frame(decoder: *mut c_void, input: *mut u8, output: *mut u8) -> i32;
}

pub(crate) struct Decoder(NonNull<c_void>);

impl Decoder {
    pub fn new() -> Result<Self, &'static str> {
        let _guard = CODEC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: fixed supported sample rate; ownership is paired with Drop.
        NonNull::new(unsafe { Siren7_NewDecoder(16000) })
            .map(Self)
            .ok_or("libsiren decoder allocation failed")
    }

    pub fn decode_g7221(&mut self, frame: &[u8; 40]) -> Result<[i16; 320], i32> {
        self.decode_with(frame, Siren7_DecodeG7221Frame)
    }

    #[cfg(test)]
    fn decode(&mut self, frame: &[u8; 40]) -> Result<[i16; 320], i32> {
        self.decode_with(frame, Siren7_DecodeFrame)
    }

    fn decode_with(
        &mut self,
        frame: &[u8; 40],
        decode: unsafe extern "C" fn(*mut c_void, *mut u8, *mut u8) -> i32,
    ) -> Result<[i16; 320], i32> {
        let _guard = CODEC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Upstream casts buffers to short*: supply aligned storage and exact sizes.
        let mut input = [0u16; 20];
        for (word, bytes) in input.iter_mut().zip(frame.chunks_exact(2)) {
            *word = u16::from_ne_bytes([bytes[0], bytes[1]]);
        }
        let mut output = [0i16; 320];
        // SAFETY: live exclusive decoder, 40 readable/640 writable aligned bytes,
        // and no concurrent access to the C library's globals.
        let status = unsafe {
            decode(
                self.0.as_ptr(),
                input.as_mut_ptr().cast(),
                output.as_mut_ptr().cast(),
            )
        };
        if status != 0 {
            return Err(status);
        }
        for sample in &mut output {
            *sample = i16::from_le(*sample);
        }
        Ok(output)
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        let _guard = CODEC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: this owns the allocation and cannot be used after drop.
        unsafe { Siren7_CloseDecoder(self.0.as_ptr()) };
    }
}

#[cfg(test)]
pub(super) fn encode_test_frames(g7221: bool) -> Vec<[u8; 40]> {
    extern "C" {
        fn Siren7_NewEncoder(rate: i32) -> *mut c_void;
        fn Siren7_EncodeFrame(encoder: *mut c_void, input: *mut u8, output: *mut u8) -> i32;
        fn Siren7_EncodeG7221Frame(encoder: *mut c_void, input: *mut u8, output: *mut u8) -> i32;
        fn Siren7_CloseEncoder(encoder: *mut c_void);
    }
    let _guard = CODEC_LOCK.lock().unwrap();
    let encode = if g7221 {
        Siren7_EncodeG7221Frame
    } else {
        Siren7_EncodeFrame
    };
    unsafe {
        let encoder = Siren7_NewEncoder(16000);
        assert!(!encoder.is_null());
        let mut frames = Vec::new();
        for frame in 0..10 {
            let mut input: [i16; 320] = std::array::from_fn(|i| {
                ((f64::sin((frame * 320 + i) as f64 * 440.0 * std::f64::consts::TAU / 16000.0)
                    * 8000.0) as i16)
                    .to_le()
            });
            let mut output = [0u16; 20];
            assert_eq!(
                encode(
                    encoder,
                    input.as_mut_ptr().cast(),
                    output.as_mut_ptr().cast()
                ),
                0
            );
            let bytes: Vec<_> = output.iter().flat_map(|word| word.to_ne_bytes()).collect();
            frames.push(bytes.try_into().unwrap());
        }
        Siren7_CloseEncoder(encoder);
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_fixed_size_frames_remain_bounded() {
        let mut decoder = Decoder::new().unwrap();
        let mut seed = 0x416u32;
        for _ in 0..4096 {
            let frame = std::array::from_fn(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            });
            let _ = decoder.decode(&frame);
            let _ = decoder.decode_g7221(&frame);
        }
    }
    #[test]
    fn decodes_encoded_tone_and_resets_history() {
        let frames = encode_test_frames(false);
        let mut decoder = Decoder::new().unwrap();
        let first = decoder.decode(&frames[0]).unwrap();
        let mut energy = 0i64;
        for frame in &frames[1..] {
            energy += decoder
                .decode(frame)
                .unwrap()
                .iter()
                .map(|&s| i64::from(s).pow(2))
                .sum::<i64>();
        }
        assert!(energy > 1_000_000);
        assert_eq!(Decoder::new().unwrap().decode(&frames[0]).unwrap(), first);
        assert!(decoder.decode(&[0xff; 40]).is_err());
    }

    #[test]
    fn g7221_tone_decodes_without_siren7_header_or_checksum() {
        let frames = encode_test_frames(true);
        let mut decoder = Decoder::new().unwrap();
        let mut energy = 0i64;
        for frame in &frames {
            energy += decoder
                .decode_g7221(frame)
                .unwrap()
                .iter()
                .map(|&s| i64::from(s).pow(2))
                .sum::<i64>();
        }
        assert!(energy > 1_000_000);
        assert!(frames
            .iter()
            .any(|frame| Decoder::new().unwrap().decode(frame).is_err()));
    }
}
