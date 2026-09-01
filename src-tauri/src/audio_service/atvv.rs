#[derive(Default)]
pub(super) struct AtvvDecoder {
    pending: Vec<u8>,
    predictor: i32,
    step_index: i32,
    pending_sync: Option<(i32, i32)>,
}

impl AtvvDecoder {
    pub(super) fn reset_session(&mut self) {
        self.pending.clear();
        self.predictor = 0;
        self.step_index = 0;
        self.pending_sync = None;
    }

    pub(super) fn synchronize(&mut self, predictor: i32, step_index: i32) {
        self.pending.clear();
        self.pending_sync = Some((predictor, step_index));
    }

    pub(super) fn append(&mut self, packet: &[u8], frame_size: usize) -> Vec<Vec<i16>> {
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
    use super::{smooth, AtvvDecoder};

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
