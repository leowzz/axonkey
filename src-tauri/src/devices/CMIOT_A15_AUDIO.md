# CMIOT-A15 FC audio

On Windows, each saved A15 instance owns a `ManagedQuarborChannel` connected to its
exact BTHLEDevice HID parent through QuarborUniversalKeyboardDriver. Discovery
merges paired Bluetooth devices with native Windows PnP inventory so replacing the
HID driver does not hide a device. Targets are matched by model and Bluetooth
address; there is no automatic selection of the first A15.

Each channel owns its HID key state, mappings, recording control, fragment
reassembler and Siren decoder. FC reports are accepted only on A15 while that
instance is recording, independently of ordinary key mappings. Hold/click recording
mode is saved in the instance's `cmiotA15RecordingMode` field (default: `hold`).

Pipeline: exact 21-byte HID report -> three consecutive fragments in one group
-> first 40 of 48 payload bytes -> ICO word rotation/XOR/endian conversion
-> libsiren Siren7 -> 320 signed PCM16 samples at 16000 Hz, mono.

The native `axonkey-device-pcm` diagnostic event carries `{ instanceId, frame }`.
The frame contains:

- `group`: source little-endian group ID.
- `sample_rate`: 16000.
- `samples`: 320 signed integer samples, in time order (20 ms).
- `headers`: original bytes 1..4 of the three reports.
- `tail`: eight auxiliary payload bytes; their meaning remains unknown.

Windows forwards decoded PCM directly to that instance's `AudioService` through
`AudioServiceManager`. A15 reuses the Windows playback implementation without
starting the RC003 BLE voice worker. Output endpoint, gain, resampling, prebuffer,
PCM queue and level diagnostics belong to the individual instance. Two A15s and
an RC003 can run concurrently; stopping one does not clear another's queue.
Selecting the same Windows playback endpoint still allows Windows to mix their
outputs. Playback does not depend on a frontend event listener. No audio file is
written and no speech recognition is performed.

Recording status is part of each instance's runtime snapshot; transitions also
emit `axonkey-device-recording` with `{ instanceId, recording }`. Audio connection
status follows that instance's driver channel and remains connected between
recordings, allowing gain calibration to finish after recording stops.

The native pending queue is capped at 32 frames, dropping the oldest on overflow;
each instance's audio queue retains the existing two-second sample limit. Original HID
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

Instance regression tests cover two physical identities, separate HID edges and
mappings, profile switch routing, recording settings, unbinding and PCM delivery.
