//! OBE_RCU_R5 voice: three encrypted 20-byte blocks form one 60-byte SBC body.

use std::sync::{Mutex, OnceLock};

const BLOCK_BYTES: usize = 20;
const BODY_BYTES: usize = 60;
const REPORT_BYTES: usize = 61;
const SBC_SAMPLES: usize = 128;
const PERMUTATION: [usize; BLOCK_BYTES] = [
    0, 12, 13, 3, 4, 9, 10, 11, 16, 17, 18, 19, 5, 6, 14, 15, 1, 2, 7, 8,
];

unsafe extern "C" {
    fn sbc_decoder_reset();
    fn sbc_decode(
        blocks_per_packet: u8,
        bitpool: u8,
        buffer: *const u8,
        length: u16,
        output: *mut i16,
    ) -> u32;
}

fn decoder_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Default)]
pub(crate) struct VoiceStream {
    active: bool,
}

impl VoiceStream {
    pub(crate) fn synchronize(&mut self, active: bool) {
        if self.active != active {
            self.reset();
            self.active = active;
        }
    }

    pub(crate) fn reset(&mut self) {
        self.active = false;
        if let Ok(_guard) = decoder_lock().lock() {
            // The native decoder keeps the SBC synthesis history globally.
            unsafe { sbc_decoder_reset() };
        }
    }

    pub(crate) fn feed(&mut self, report: &[u8]) -> Result<Option<Vec<i16>>, String> {
        if !self.active || report.first() != Some(&0x1e) {
            return Ok(None);
        }
        if report.len() != REPORT_BYTES {
            return Err(format!(
                "OBE_RCU_R5 voice report must contain {REPORT_BYTES} bytes, got {}",
                report.len()
            ));
        }
        let mut body = [0u8; BODY_BYTES];
        for chunk in 0..3 {
            decrypt20(
                &report[1 + chunk * BLOCK_BYTES..1 + (chunk + 1) * BLOCK_BYTES],
                &mut body[chunk * BLOCK_BYTES..(chunk + 1) * BLOCK_BYTES],
            );
        }
        let mut packet = [0u8; 64];
        packet[..4].copy_from_slice(&[0xad, 0x31, 0x1c, 0]);
        packet[4..].copy_from_slice(&body);
        let mut samples = [0i16; SBC_SAMPLES];
        let _guard = decoder_lock()
            .lock()
            .map_err(|_| "OBE_RCU_R5 SBC decoder lock is unavailable".to_string())?;
        let produced = unsafe {
            sbc_decode(
                16,
                28,
                packet.as_ptr(),
                packet.len() as u16,
                samples.as_mut_ptr(),
            )
        };
        if produced != SBC_SAMPLES as u32 {
            return Err(format!(
                "OBE_RCU_R5 SBC decoder produced {produced} samples"
            ));
        }
        Ok(Some(samples.to_vec()))
    }
}

fn decrypt20(input: &[u8], output: &mut [u8]) {
    let mut work = [0u8; BLOCK_BYTES];
    work.copy_from_slice(input);
    for j in (1..BLOCK_BYTES).rev() {
        work[PERMUTATION[j]] =
            work[PERMUTATION[j]].wrapping_add(work[PERMUTATION[j - 1]]) ^ (j as u8 ^ 0x32);
    }
    work[0] = work[0].wrapping_sub(0x3e) ^ 0x32;
    output.copy_from_slice(&work);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_the_known_first_transport_block() {
        let input = [
            0xcc, 0x65, 0x8a, 0x54, 0x61, 0x1c, 0x68, 0x0d, 0x85, 0x2b, 0x5d, 0x31, 0x3c, 0x47,
            0xa3, 0x89, 0xd6, 0x0f, 0x56, 0x69,
        ];
        let mut output = [0u8; BLOCK_BYTES];
        decrypt20(&input, &mut output);
        assert_eq!(
            output,
            [
                0xbc, 0xcc, 0xcc, 0xaa, 0x83, 0xbb, 0xbb, 0xb7, 0xb3, 0xbb, 0xbc, 0xbb, 0x3b, 0xb3,
                0x37, 0x11, 0x3d, 0xde, 0x5d, 0x86,
            ]
        );
    }

    #[test]
    fn decodes_a_captured_report_to_one_sbc_frame() {
        let report = [
            0x1e, 0xcc, 0x65, 0x8a, 0x54, 0x61, 0x1c, 0x68, 0x0d, 0x85, 0x2b, 0x5d, 0x31, 0x3c,
            0x47, 0xa3, 0x89, 0xd6, 0x0f, 0x56, 0x69, 0xc6, 0x98, 0x57, 0xfa, 0x90, 0x8c, 0xff,
            0xc4, 0xd2, 0xfc, 0x93, 0xfb, 0x82, 0x09, 0x88, 0x02, 0x86, 0xfa, 0x89, 0xb9, 0xc7,
            0xf7, 0x9d, 0x00, 0x8d, 0xa1, 0xa3, 0xfe, 0x9c, 0xf3, 0x9c, 0xf2, 0xc1, 0x8a, 0xe4,
            0xa2, 0x9b, 0xe5, 0x9e, 0xe4,
        ];
        let mut stream = VoiceStream::default();
        stream.synchronize(true);
        let samples = stream.feed(&report).unwrap().unwrap();
        assert_eq!(samples.len(), SBC_SAMPLES);
        assert!(samples.iter().any(|sample| *sample != 0));
    }

    #[test]
    fn ignores_reports_outside_an_active_voice_session() {
        let mut stream = VoiceStream::default();
        assert!(stream.feed(&[0x1e; REPORT_BYTES]).unwrap().is_none());
        stream.synchronize(true);
        assert!(stream.feed(&[1; 60]).unwrap().is_none());
    }
}
