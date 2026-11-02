//! Preserve HID report boundaries and apply the ICO-to-Siren wire transform.

/// PCM samples are signed 16-bit mono at 16 kHz (320 samples / 20 ms).
#[derive(Clone, serde::Serialize)]
pub(crate) struct PcmFrame {
    pub group: u16,
    pub sample_rate: u32,
    pub samples: Vec<i16>,
    pub tail: [u8; 8],
    pub headers: [[u8; 4]; 3],
}

#[derive(Default)]
pub(crate) struct VoiceStream {
    active: bool,
    assembler: Reassembler,
    decoder: Option<super::siren::Decoder>,
}

impl VoiceStream {
    pub fn synchronize(&mut self, active: bool) {
        if self.active != active {
            self.reset();
            self.active = active;
        }
    }

    pub fn reset(&mut self) {
        self.active = false;
        self.assembler.reset();
        self.decoder = None;
    }

    pub fn feed(&mut self, report: &[u8]) -> Result<Option<PcmFrame>, String> {
        if !self.active {
            return Ok(None);
        }
        let frame = match self.assembler.feed(report) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(None),
            Err(error) => {
                self.decoder = None;
                return Err(error.into());
            }
        };
        if self.decoder.is_none() {
            self.decoder = Some(super::siren::Decoder::new()?);
        }
        let samples = match self
            .decoder
            .as_mut()
            .unwrap()
            .decode_g7221(&unscramble_ico(&frame.data))
        {
            Ok(samples) => samples.to_vec(),
            Err(code) => {
                self.decoder = None;
                return Err(format!(
                    "libsiren rejected FC group {} (code {code})",
                    frame.group
                ));
            }
        };
        Ok(Some(PcmFrame {
            group: frame.group,
            sample_rate: 16000,
            samples,
            tail: frame.tail,
            headers: frame.headers,
        }))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct EncodedFrame {
    pub group: u16,
    pub data: [u8; 40],
    pub tail: [u8; 8],
    pub headers: [[u8; 4]; 3],
}

#[derive(Default)]
pub(crate) struct Reassembler {
    synchronized: bool,
    group: Option<u16>,
    count: usize,
    reports: [[u8; 21]; 3],
    last_report: Option<[u8; 21]>,
}

impl Reassembler {
    pub(crate) fn reset(&mut self) {
        self.synchronized = false;
        self.group = None;
        self.count = 0;
        self.reports.fill([0; 21]);
        self.last_report = None;
    }

    pub(crate) fn feed(&mut self, report: &[u8]) -> Result<Option<EncodedFrame>, &'static str> {
        if report.first().is_some_and(|id| *id != 0xfc) {
            return Ok(None);
        }
        if report.len() != 21 {
            self.reset();
            return Err("FC report must contain exactly 21 bytes including report ID");
        }
        if self.last_report.as_ref().is_some_and(|last| last == report) {
            return Ok(None);
        }
        let group = u16::from_le_bytes([report[1], report[2]]);
        let fragment = usize::from(report[3]);
        if fragment > 2 {
            self.reset();
            return Err("FC fragment index must be 0, 1 or 2");
        }
        if self.group == Some(group)
            && self.count > 0
            && fragment == self.count - 1
            && report == self.reports[fragment]
        {
            return Ok(None);
        }
        if fragment == 0 {
            self.reset();
            self.synchronized = true;
            self.group = Some(group);
        } else if !self.synchronized {
            // Capture can start mid-group; wait for the first complete frame boundary.
            return Ok(None);
        } else if self.group != Some(group) || fragment != self.count {
            self.reset();
            return Err("FC group is incomplete or out of order; waiting for fragment zero");
        }
        self.reports[fragment].copy_from_slice(report);
        self.last_report = Some(report.try_into().unwrap());
        self.count += 1;
        if self.count != 3 {
            return Ok(None);
        }
        let mut joined = [0; 48];
        let mut headers = [[0; 4]; 3];
        for (index, packet) in self.reports.iter().enumerate() {
            joined[index * 16..(index + 1) * 16].copy_from_slice(&packet[5..21]);
            headers[index].copy_from_slice(&packet[1..5]);
        }
        let frame = EncodedFrame {
            group,
            data: joined[..40].try_into().unwrap(),
            tail: joined[40..].try_into().unwrap(),
            headers,
        };
        self.reset();
        self.synchronized = true;
        self.last_report = Some(report.try_into().unwrap());
        Ok(Some(frame))
    }
}

pub(crate) fn unscramble_ico(block: &[u8; 40]) -> [u8; 40] {
    let mut words = [0u16; 20];
    for (word, pair) in words.iter_mut().zip(block.chunks_exact(2)) {
        *word = u16::from_le_bytes([pair[0], pair[1]]);
    }
    for (a, b, c) in [(4, 16, 9), (8, 3, 11), (2, 6, 18), (7, 13, 17)] {
        (words[a], words[b], words[c]) = (words[c], words[a], words[b]);
    }
    let mut result = [0; 40];
    for (pair, word) in result.chunks_exact_mut(2).zip(words) {
        pair.copy_from_slice(&(word ^ 0x0416).to_be_bytes());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_a15_group_uses_headerless_g7221_and_ignores_driver_duplicates() {
        // One 20 ms group from the physical A15, not a Siren7 encoder fixture.
        let reports = [
            [
                0xfc, 0x4b, 0x5f, 0x00, 0x00, 0x48, 0xbc, 0x92, 0xd4, 0xde, 0xeb, 0x0e, 0xc1, 0x9e,
                0x2d, 0x5f, 0xb0, 0x56, 0xe6, 0x9a, 0x06,
            ],
            [
                0xfc, 0x4b, 0x5f, 0x01, 0x00, 0x01, 0xef, 0x2e, 0xb0, 0x4d, 0x0c, 0x71, 0xec, 0x7c,
                0xbc, 0x18, 0x30, 0x8c, 0x31, 0xbb, 0xad,
            ],
            [
                0xfc, 0x4b, 0x5f, 0x02, 0x00, 0xf2, 0x02, 0xb2, 0x92, 0x95, 0x06, 0x21, 0x91, 0x04,
                0x00, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x00,
            ],
        ];
        let mut stream = VoiceStream::default();
        stream.synchronize(true);
        let mut decoded = Vec::new();
        for report in reports {
            for _ in 0..4 {
                if let Some(frame) = stream.feed(&report).unwrap() {
                    decoded.push(frame);
                }
            }
        }
        assert_eq!(decoded.len(), 1);
        let frame = &decoded[0];
        assert_eq!(frame.group, 0x5f4b);
        assert_eq!(frame.samples.len(), 320);
        assert_eq!(frame.tail, [4, 0, 29, 0, 0, 0, 0, 0]);
        let peak = frame
            .samples
            .iter()
            .map(|s| i32::from(*s).abs())
            .max()
            .unwrap();
        assert!((3500..3600).contains(&peak), "captured frame peak: {peak}");
    }

    #[test]
    fn full_fc_pipeline_decodes_and_does_not_leak_between_sessions() {
        let encoded = super::super::siren::encode_test_frames(true)[0];
        let mut words = [0u16; 20];
        for (word, pair) in words.iter_mut().zip(encoded.chunks_exact(2)) {
            *word = u16::from_be_bytes(pair.try_into().unwrap()) ^ 0x0416;
        }
        for (a, b, c) in [(4, 16, 9), (8, 3, 11), (2, 6, 18), (7, 13, 17)] {
            (words[a], words[b], words[c]) = (words[b], words[c], words[a]);
        }
        let mut joined = [0u8; 48];
        for (pair, word) in joined[..40].chunks_exact_mut(2).zip(words) {
            pair.copy_from_slice(&word.to_le_bytes());
        }
        joined[40..].fill(0x99);
        let packets: [[u8; 21]; 3] = std::array::from_fn(|i| {
            let mut p = packet(42, i as u8);
            p[5..].copy_from_slice(&joined[i * 16..i * 16 + 16]);
            p
        });
        let mut stream = VoiceStream::default();
        assert!(stream.feed(&packets[0]).unwrap().is_none());
        stream.synchronize(true);
        for p in &packets[..2] {
            assert!(stream.feed(p).unwrap().is_none());
        }
        let pcm = stream.feed(&packets[2]).unwrap().unwrap();
        assert_eq!(
            pcm.samples,
            super::super::siren::Decoder::new()
                .unwrap()
                .decode_g7221(&encoded)
                .unwrap()
        );
        assert_eq!(pcm.tail, [0x99; 8]);
        assert!(stream.feed(&packets[2]).unwrap().is_none());
        stream.feed(&packets[0]).unwrap();
        stream.synchronize(false);
        stream.synchronize(true);
        assert!(stream.feed(&packets[1]).unwrap().is_none());
        assert!(stream.feed(&packets[2]).unwrap().is_none());
        for p in &packets[..2] {
            stream.feed(p).unwrap();
        }
        assert_eq!(
            stream.feed(&packets[2]).unwrap().unwrap().samples,
            pcm.samples
        );
    }
    fn packet(group: u16, part: u8) -> [u8; 21] {
        let mut p = [0; 21];
        p[0] = 0xfc;
        p[1..3].copy_from_slice(&group.to_le_bytes());
        p[3] = part;
        p[4] = 0xab;
        for (i, b) in p[5..].iter_mut().enumerate() {
            *b = part * 16 + i as u8;
        }
        p
    }
    #[test]
    fn preserves_tail_headers_and_duplicate_boundaries() {
        let mut assembler = Reassembler::default();
        assert!(assembler.feed(&packet(65535, 0)).unwrap().is_none());
        assert!(assembler.feed(&packet(65535, 0)).unwrap().is_none());
        assert!(assembler.feed(&[3, 0, 0]).unwrap().is_none());
        assert!(assembler.feed(&packet(65535, 1)).unwrap().is_none());
        let frame = assembler.feed(&packet(65535, 2)).unwrap().unwrap();
        assert_eq!(frame.data, std::array::from_fn(|i| i as u8));
        assert_eq!(frame.tail, [40, 41, 42, 43, 44, 45, 46, 47]);
        assert_eq!(frame.headers[2], [255, 255, 2, 0xab]);
        assert!(assembler.feed(&packet(0, 0)).unwrap().is_none());
    }
    #[test]
    fn rejects_missing_cross_group_and_malformed_fragments() {
        let mut assembler = Reassembler::default();
        assembler.feed(&packet(1, 0)).unwrap();
        assert!(assembler.feed(&packet(1, 2)).is_err());
        assembler.feed(&packet(1, 0)).unwrap();
        assert!(assembler.feed(&packet(2, 1)).is_err());
        assembler.feed(&packet(2, 0)).unwrap();
        assembler.reset();
        assert!(assembler.feed(&packet(2, 1)).unwrap().is_none());
        assert!(assembler.feed(&[0xfc; 20]).is_err());
        assert!(assembler.feed(&packet(2, 3)).is_err());
    }
    #[test]
    fn waits_for_initial_boundary_and_recovers_after_packet_loss() {
        let mut assembler = Reassembler::default();
        for part in [1, 2] {
            assert!(assembler.feed(&packet(1, part)).unwrap().is_none());
        }
        for part in [0, 1] {
            assert!(assembler.feed(&packet(2, part)).unwrap().is_none());
        }
        assert_eq!(assembler.feed(&packet(2, 2)).unwrap().unwrap().group, 2);
        // Once synchronized, a missing fragment zero is still a real packet loss.
        assert!(assembler.feed(&packet(3, 1)).is_err());
        assert!(assembler.feed(&packet(3, 2)).unwrap().is_none());
        assembler.feed(&packet(4, 0)).unwrap();
        assembler.feed(&packet(4, 1)).unwrap();
        assert_eq!(assembler.feed(&packet(4, 2)).unwrap().unwrap().group, 4);
    }
    #[test]
    fn unscramble_matches_python_word_rotation_and_endianness() {
        let input = std::array::from_fn(|i| if i % 2 == 0 { (i / 2) as u8 } else { 0 });
        let output = unscramble_ico(&input);
        let expected = [
            0, 1, 18, 8, 9, 5, 2, 17, 11, 16, 10, 3, 12, 7, 14, 15, 4, 13, 6, 19,
        ];
        for (pair, word) in output.chunks_exact(2).zip(expected) {
            assert_eq!(u16::from_be_bytes(pair.try_into().unwrap()), word ^ 0x0416);
        }
    }
}
