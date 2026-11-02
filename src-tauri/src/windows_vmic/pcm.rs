use super::device::PcmFormat;
use rubato::{
    Resampler, SincFixedOut, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

const SOURCE_SAMPLE_RATE: u32 = 16_000;
const MAX_QUEUED_SAMPLES: usize = SOURCE_SAMPLE_RATE as usize * 2;
const SINC_LEN: usize = 64;
const INPUT_IDLE_DELAY: Duration = Duration::from_millis(40);

#[derive(Clone)]
pub(crate) struct AudioSource(Arc<Mutex<SourceState>>);

impl AudioSource {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Mutex::new(SourceState {
            samples: VecDeque::new(),
            gain: 1.0,
            converter: None,
            last_pcm_at: None,
        })))
    }

    pub(crate) fn push_pcm(&self, pcm: &[i16]) {
        let mut source = self.0.lock().unwrap();
        let overflow = (source.samples.len() + pcm.len()).saturating_sub(MAX_QUEUED_SAMPLES);
        let remove = overflow.min(source.samples.len());
        source.samples.drain(..remove);
        source.samples.extend(&pcm[overflow - remove..]);
        source.last_pcm_at = Some(Instant::now());
    }

    pub(crate) fn set_gain_db(&self, gain: i16) {
        self.0.lock().unwrap().gain = 10.0_f32.powf(f32::from(gain) / 20.0);
    }

    pub(crate) fn clear(&self) {
        self.0.lock().unwrap().clear();
    }

    #[cfg(test)]
    pub(crate) fn queued_samples(&self) -> usize {
        self.0.lock().unwrap().samples.len()
    }
}

struct SourceState {
    samples: VecDeque<i16>,
    gain: f32,
    converter: Option<Converter>,
    last_pcm_at: Option<Instant>,
}

impl SourceState {
    fn clear(&mut self) {
        self.samples.clear();
        self.converter = None;
        self.last_pcm_at = None;
    }

    fn mix_into(&mut self, format: PcmFormat, mixed: &mut [f32]) -> bool {
        let input_idle = self
            .last_pcm_at
            .is_some_and(|last| last.elapsed() >= INPUT_IDLE_DELAY);
        if format.sample_rate == SOURCE_SAMPLE_RATE {
            self.converter = None;
            if self.samples.is_empty() || (self.samples.len() < mixed.len() && !input_idle) {
                return false;
            }
            for output in mixed {
                *output +=
                    f32::from(self.samples.pop_front().unwrap_or_default()) / 32768.0 * self.gain;
            }
            return true;
        }

        let changed = self.converter.as_ref().is_none_or(|converter| {
            converter.format != format || converter.output[0].len() != mixed.len()
        });
        if changed {
            self.converter = Some(Converter::new(format, mixed.len()));
        }
        let converter = self.converter.as_mut().unwrap();
        if self.samples.is_empty() && converter.tail_input_frames == 0 {
            return false;
        }

        let needed = converter.resampler.input_frames_next();
        let prefix = converter.preroll_input_frames;
        // A 15 ms packet does not divide into 10 ms output blocks. Retain its
        // remainder for the next packet; only pad a source after it goes idle.
        if self.samples.len() < needed - prefix && !input_idle {
            return false;
        }
        converter.input[0].fill(0.0);
        converter.preroll_input_frames = 0;
        let supplied = self.samples.len().min(needed - prefix);
        for input in &mut converter.input[0][prefix..prefix + supplied] {
            *input = f32::from(self.samples.pop_front().unwrap()) / 32768.0 * self.gain;
        }

        let silence = needed - prefix - supplied;
        converter.tail_input_frames = if supplied > 0 {
            SINC_LEN.saturating_sub(silence)
        } else {
            converter.tail_input_frames.saturating_sub(silence)
        };
        converter
            .resampler
            .process_into_buffer(&converter.input, &mut converter.output, None)
            .expect("resampler buffers match input_frames_next and the output chunk size");
        for (output, sample) in mixed.iter_mut().zip(&converter.output[0]) {
            *output += sample;
        }
        true
    }
}

struct Converter {
    format: PcmFormat,
    resampler: SincFixedOut<f32>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
    preroll_input_frames: usize,
    tail_input_frames: usize,
}

impl Converter {
    fn new(format: PcmFormat, frames: usize) -> Self {
        let ratio = f64::from(format.sample_rate) / f64::from(SOURCE_SAMPLE_RATE);
        let resampler = SincFixedOut::new(
            ratio,
            1.0,
            SincInterpolationParameters {
                sinc_len: SINC_LEN,
                f_cutoff: 0.90,
                oversampling_factor: 128,
                interpolation: SincInterpolationType::Cubic,
                window: WindowFunction::BlackmanHarris2,
            },
            frames,
            1,
        )
        .expect("driver sample rates and a positive output chunk form a valid resampler");
        // The first fixed-output block needs filter lookahead. Prefix silence
        // keeps it from consuming extra remote samples and causing a gap next tick.
        let preroll_input_frames =
            resampler.input_frames_next() - (frames as f64 / ratio).ceil() as usize;
        let input = resampler.input_buffer_allocate(true);
        let output = resampler.output_buffer_allocate(true);
        Self {
            format,
            resampler,
            input,
            output,
            preroll_input_frames,
            tail_input_frames: 0,
        }
    }
}

#[derive(Default)]
pub(super) struct Mixer {
    sources: Vec<Weak<Mutex<SourceState>>>,
}

impl Mixer {
    pub(super) fn add_source(&mut self, source: &AudioSource) {
        self.sources.push(Arc::downgrade(&source.0));
    }

    pub(super) fn render(&mut self, format: PcmFormat, frames: usize) -> Option<Vec<u8>> {
        let mut mixed = vec![0.0; frames];
        let mut active = false;
        self.sources.retain(|source| {
            let Some(source) = source.upgrade() else {
                return false;
            };
            active |= source.lock().unwrap().mix_into(format, &mut mixed);
            true
        });
        active.then(|| encode_pcm(&mixed, format))
    }

    pub(super) fn clear(&mut self) {
        for source in self.sources.iter().filter_map(Weak::upgrade) {
            source.lock().unwrap().clear();
        }
    }
}

fn encode_pcm(samples: &[f32], format: PcmFormat) -> Vec<u8> {
    let sample_bytes = usize::from(format.bits_per_sample / 8);
    let mut bytes = Vec::with_capacity(samples.len() * usize::from(format.channels) * sample_bytes);
    for sample in samples {
        let encoded = match format.bits_per_sample {
            16 => {
                ((*sample * 32768.0).round().clamp(-32768.0, 32767.0) as i16 as i32).to_le_bytes()
            }
            24 => ((*sample * 8388608.0).round().clamp(-8388608.0, 8388607.0) as i32).to_le_bytes(),
            _ => unreachable!("driver format validation accepts only PCM16 and PCM24"),
        };
        for _ in 0..format.channels {
            bytes.extend_from_slice(&encoded[..sample_bytes]);
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(sample_rate: u32, bits_per_sample: u16, channels: u16) -> PcmFormat {
        PcmFormat {
            sample_rate,
            bits_per_sample,
            channels,
        }
    }

    fn mono_samples(pcm: &[u8]) -> Vec<i16> {
        pcm.chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
            .collect()
    }

    #[test]
    fn mixes_sources_by_addition_with_independent_live_gain_and_saturation() {
        let first = AudioSource::new();
        let second = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&first);
        mixer.add_source(&second);
        first.push_pcm(&[2000, 20_000, -20_000, 1000]);
        second.push_pcm(&[3000, 20_000, -20_000, -1000]);
        assert_eq!(
            mono_samples(&mixer.render(format(16000, 16, 1), 3).unwrap()),
            [5000, i16::MAX, i16::MIN]
        );
        first.set_gain_db(6);
        assert_eq!(
            mono_samples(&mixer.render(format(16000, 16, 1), 1).unwrap()),
            [995]
        );
        assert!(mixer.render(format(16000, 16, 1), 1).is_none());
    }

    #[test]
    fn encodes_pcm24_as_three_little_endian_bytes_and_duplicates_stereo() {
        let source = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&source);
        source.push_pcm(&[i16::MIN, -1, 1, 0x1234]);
        let pcm = mixer.render(format(16000, 24, 2), 4).unwrap();
        assert_eq!(
            pcm,
            [
                0x00, 0x00, 0x80, 0x00, 0x00, 0x80, 0x00, 0xff, 0xff, 0x00, 0xff, 0xff, 0x00, 0x01,
                0x00, 0x00, 0x01, 0x00, 0x00, 0x34, 0x12, 0x00, 0x34, 0x12,
            ]
        );
    }

    #[test]
    fn partial_input_is_padded_with_silence_without_repeating_the_last_sample() {
        let source = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&source);
        source.push_pcm(&[1234, -1234]);
        assert!(mixer.render(format(16000, 16, 1), 5).is_none());
        source.0.lock().unwrap().last_pcm_at = Some(Instant::now() - INPUT_IDLE_DELAY);
        assert_eq!(
            mono_samples(&mixer.render(format(16000, 16, 1), 5).unwrap()),
            [1234, -1234, 0, 0, 0]
        );
        assert!(mixer.render(format(16000, 16, 1), 5).is_none());
    }

    #[test]
    fn queues_keep_only_the_latest_two_seconds_and_dropped_sources_do_not_play() {
        let source = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&source);
        source.push_pcm(&[1; 100]);
        source.push_pcm(&vec![2; MAX_QUEUED_SAMPLES + 100]);
        assert_eq!(source.queued_samples(), MAX_QUEUED_SAMPLES);
        assert_eq!(
            mono_samples(&mixer.render(format(16000, 16, 1), 10).unwrap()),
            [2; 10]
        );
        drop(source);
        assert!(mixer.render(format(16000, 16, 1), 10).is_none());
        assert!(mixer.sources.is_empty());
    }

    #[test]
    fn resampling_is_continuous_across_remote_packets_and_all_supported_rates() {
        for sample_rate in [8000, 24000, 32000, 44100, 48000, 96000, 192000] {
            let output_format = format(sample_rate, 16, 1);
            let frames = sample_rate as usize / 100;
            let source = AudioSource::new();
            let mut mixer = Mixer::default();
            mixer.add_source(&source);
            let mut rendered = Vec::new();
            for _ in 0..10 {
                source.push_pcm(&[4000; 320]);
                for _ in 0..2 {
                    rendered.extend(mono_samples(&mixer.render(output_format, frames).unwrap()));
                }
            }
            assert!(
                rendered[frames..]
                    .iter()
                    .all(|sample| (sample - 4000).abs() <= 2),
                "a continuous 20 ms source must not acquire a gap at {sample_rate} Hz"
            );
            assert_eq!(source.queued_samples(), 0);
        }
    }

    #[test]
    fn sustained_a15_resampling_consumes_exactly_160_samples_per_ten_ms_block() {
        let source = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&source);
        let output_format = format(48000, 16, 2);
        for packet in 0..1000 {
            source.push_pcm(&[4000; 320]);
            for block in 0..2 {
                let before = source.queued_samples();
                let pcm = mixer.render(output_format, 480).unwrap();
                assert_eq!(pcm.len(), 1920);
                assert_eq!(
                    before - source.queued_samples(),
                    160,
                    "source consumption drifted at packet {packet}, block {block}"
                );
            }
            assert_eq!(source.queued_samples(), 0);
        }
    }

    #[test]
    fn twenty_ms_fifo_prefill_does_not_insert_tail_blocks_between_remote_packets() {
        let input: Vec<_> = (0..3200)
            .map(|index| {
                (10000.0 * (index as f32 * std::f32::consts::TAU * 997.0 / 16000.0).sin()) as i16
            })
            .collect();
        for sample_rate in [8000, 44100, 48000, 192000] {
            let whole = AudioSource::new();
            let packets = AudioSource::new();
            let mut whole_mixer = Mixer::default();
            let mut packet_mixer = Mixer::default();
            whole_mixer.add_source(&whole);
            packet_mixer.add_source(&packets);
            whole.push_pcm(&input);
            for packet in input.chunks(320) {
                packets.push_pcm(packet);
                for _ in 0..2 {
                    assert_eq!(
                        whole_mixer.render(format(sample_rate, 16, 1), sample_rate as usize / 100),
                        packet_mixer.render(format(sample_rate, 16, 1), sample_rate as usize / 100),
                        "packet boundary changed the waveform at {sample_rate} Hz"
                    );
                }
                // At t=10 ms the driver has consumed half its prefilled FIFO,
                // while the next 20 ms remote packet has not arrived yet.
                packets.0.lock().unwrap().last_pcm_at =
                    Some(Instant::now() - Duration::from_millis(10));
                assert!(packet_mixer
                    .render(format(sample_rate, 16, 1), sample_rate as usize / 100)
                    .is_none());
            }
        }
    }

    #[test]
    fn fifteen_ms_packets_keep_partial_input_until_the_next_packet_without_padding() {
        let input: Vec<_> = (0..4800)
            .map(|index| {
                (9000.0 * (index as f32 * std::f32::consts::TAU * 997.0 / 16000.0).sin()) as i16
            })
            .collect();
        for sample_rate in [16000, 44100, 48000] {
            let output_format = format(sample_rate, 16, 1);
            let frames = sample_rate as usize / 100;
            let whole = AudioSource::new();
            let packets = AudioSource::new();
            let mut whole_mixer = Mixer::default();
            let mut packet_mixer = Mixer::default();
            whole_mixer.add_source(&whole);
            packet_mixer.add_source(&packets);
            whole.push_pcm(&input);
            let mut next_packet = 0;
            let mut fifo_blocks: usize = 0;
            let mut written_blocks = 0;
            for tick_ms in (0..=310).step_by(10) {
                while next_packet < 20 && next_packet * 15 <= tick_ms {
                    packets.push_pcm(&input[next_packet * 240..(next_packet + 1) * 240]);
                    next_packet += 1;
                }
                packets.0.lock().unwrap().last_pcm_at = Some(
                    Instant::now()
                        - Duration::from_millis((tick_ms - (next_packet - 1) * 15) as u64),
                );
                fifo_blocks = fifo_blocks.saturating_sub(1);
                for _ in fifo_blocks..2 {
                    let Some(pcm) = packet_mixer.render(output_format, frames) else {
                        break;
                    };
                    assert_eq!(
                        Some(pcm),
                        whole_mixer.render(output_format, frames),
                        "a partial 15 ms packet changed the waveform at t={tick_ms} ms, {sample_rate} Hz"
                    );
                    fifo_blocks += 1;
                    written_blocks += 1;
                }
            }
            assert_eq!(written_blocks, 30, "300 ms of input must stay 300 ms");
            assert_eq!(packets.queued_samples(), 0);
        }
    }

    #[test]
    fn downsampling_filters_frequencies_above_the_output_nyquist_limit() {
        let source = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&source);
        let input: Vec<_> = (0..3200)
            .map(|index| {
                (10000.0 * (index as f32 * std::f32::consts::TAU * 6000.0 / 16000.0).sin()) as i16
            })
            .collect();
        source.push_pcm(&input);
        mixer.render(format(8000, 16, 1), 80).unwrap();
        let mut pcm = Vec::new();
        for _ in 0..10 {
            pcm.extend(mono_samples(
                &mixer.render(format(8000, 16, 1), 80).unwrap(),
            ));
        }
        let rms = (pcm
            .iter()
            .map(|sample| f32::from(*sample).powi(2))
            .sum::<f32>()
            / pcm.len() as f32)
            .sqrt();
        assert!(
            rms < 100.0,
            "6 kHz must be suppressed before conversion to 8 kHz: RMS={rms}"
        );
    }

    #[test]
    fn resampler_tail_is_drained_then_becomes_idle_and_clear_removes_it() {
        let source = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&source);
        let output_format = format(48000, 16, 1);
        source.push_pcm(&[4000; 160]);
        mixer.render(output_format, 480).unwrap();
        assert!(mixer.render(output_format, 480).is_none());
        source.0.lock().unwrap().last_pcm_at = Some(Instant::now() - INPUT_IDLE_DELAY);
        let tail = mixer.render(output_format, 480).unwrap();
        assert!(mono_samples(&tail).iter().any(|sample| *sample != 0));
        assert!(mixer.render(output_format, 480).is_none());

        source.push_pcm(&[4000; 160]);
        mixer.render(output_format, 480).unwrap();
        source.clear();
        assert!(mixer.render(output_format, 480).is_none());

        source.push_pcm(&[4000; 160]);
        mixer.render(output_format, 480).unwrap();
        mixer.clear();
        assert!(mixer.render(output_format, 480).is_none());
    }

    #[test]
    fn changing_format_discards_previous_filter_tail_and_source_clear_is_independent() {
        let first = AudioSource::new();
        let second = AudioSource::new();
        let mut mixer = Mixer::default();
        mixer.add_source(&first);
        mixer.add_source(&second);
        first.push_pcm(&[8000; 160]);
        mixer.render(format(48000, 16, 1), 480).unwrap();
        assert!(mixer.render(format(44100, 24, 2), 441).is_none());
        first.push_pcm(&[8000; 160]);
        second.push_pcm(&[2000; 160]);
        first.clear();
        assert_eq!(
            mono_samples(&mixer.render(format(16000, 16, 1), 160).unwrap()),
            [2000; 160]
        );
    }
}
