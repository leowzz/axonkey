# CMIOT-A15 FC audio

The Windows HID route recognizes FC only on the A15 device. Voice data is accepted
while recording is active, independently of ordinary key mappings.

Pipeline: exact 21-byte HID report -> three consecutive fragments in one group
-> first 40 of 48 payload bytes -> ICO word rotation/XOR/endian conversion
-> libsiren Siren7 -> 320 signed PCM16 samples at 16000 Hz, mono.

The native `axonkey-cmiot-a15-pcm` event carries:

- `group`: source little-endian group ID.
- `sample_rate`: 16000.
- `samples`: 320 signed integer samples, in time order (20 ms).
- `headers`: original bytes 1..4 of the three reports.
- `tail`: eight auxiliary payload bytes; their meaning remains unknown.

Windows forwards decoded PCM directly into the existing Xiaomi `AudioService`,
sharing the configured Windows playback endpoint, 16 kHz resampling, gain, prebuffer,
bounded PCM queue and level diagnostics. The event remains available for
diagnostics; playback does not depend on a frontend event listener. No audio
file is written and no speech recognition is performed.

A15 owns the shared output while its recording flag is active. Xiaomi audio is
not enqueued during that time, but its decoder continues tracking its own stream.
Source transitions clear the queue and invalidate the playback interpolation
cursor. Xiaomi reconnect/stop events cannot clear an active A15 queue. After
A15 stops, subsequent Xiaomi PCM can use the channel again. This is deliberately
one output channel, with no simultaneous mixing or separate A15 output settings.

The native pending queue is capped at 32 frames, dropping the oldest on overflow;
the shared audio queue retains the existing two-second sample limit. Original HID
reports remain in the existing report event path. Decode errors are rate-limited
in the audio log.

Start/stop, disconnect, transport loss and mode changes reset session state.
Partial/cross-group/malformed fragments are discarded, duplicate reports ignored.
The DSP history is reset after reported fragment errors; no time
stretching or missing-frame insertion is performed. Upstream libsiren may conceal
checksum errors with its previous-frame fallback rather than return an error.

The decoder and reassembler are platform-independent. Only the existing Windows
HID route is wired here; macOS A15 transport is separate work.

Validation uses generated Siren tone frames, the inverse ICO transformation and
synthetic FC packets, plus session reset and malformed packet tests. These do not
establish compatibility or audio quality for actual A15 recordings. The provided
reverse-engineering document also identifies the 21-byte format as requiring real
capture confirmation. No FFmpeg is used in the implementation or tests.
