# CMIOT-A15 FC audio

On Windows, each saved A15 instance owns a `ManagedQuarborChannel` connected to its
exact BTHLEDevice HID parent through QuarborUniversalKeyboardDriver. Discovery
merges paired Bluetooth devices with native Windows PnP inventory so replacing the
HID driver does not hide a device. Targets are matched by model and Bluetooth
address; there is no automatic selection of the first A15.

Each channel owns its HID key state, mappings, recording control, fragment
reassembler and G.722.1 decoder. FC reports are accepted only on A15 while that
instance is recording, independently of ordinary key mappings. Hold/click recording
mode is saved in the instance's `cmiotA15RecordingMode` field (default: `hold`).
Voice-key edges also run the configured key mapping. A single mapped key such as
right Alt follows the physical press/release in both recording modes; click mode
toggles recording independently and does not latch the mapped key.

Pipeline: exact 21-byte HID report -> three consecutive fragments in one group
-> first 40 of 48 payload bytes -> ICO word rotation/XOR/endian conversion
-> libsiren G.722.1 mode -> 320 signed PCM16 samples at 16000 Hz, mono.

A15 frames use `GetSirenCodecInfo(0, ...)`: no sample-rate header bits, no
checksum bits, envelope adjustment 7 and scale factor 22. The upstream Siren7
entry point uses mode 1 (two sample-rate bits and a four-bit checksum), which
rejects or conceals real A15 frames. The bundled codec exposes separate G.722.1
encode/decode entry points while preserving the original Siren7 API.

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

Recording status is part of each instance's runtime snapshot; Windows transitions also
emit `axonkey-device-recording` with `{ instanceId, recording }`. Audio connection
status follows that instance's driver channel and remains connected between
recordings, allowing gain calibration to finish after recording stops.

The Windows native pending queue is capped at 32 frames, dropping the oldest on overflow;
each instance's audio queue retains the existing two-second sample limit. Original HID
reports remain in the existing report event path. Decode errors are rate-limited
in the audio log.

Start/stop, disconnect, transport loss and mode changes reset session state.
Partial/cross-group/malformed fragments are discarded, duplicate reports ignored.
The DSP history is reset after reported fragment errors; no time
stretching or missing-frame insertion is performed. Upstream libsiren may conceal
bitstream errors with its previous-frame fallback rather than return an error.

The decoder and reassembler are platform-independent. macOS opens the bound
0416:0300 keyboard HID exclusively through hidapi/IOHID, reads the numbered
reports and writes the same FB start/stop output reports. Input Monitoring and
Accessibility permissions are required for capture and mapped output respectively.
`managed/a15.rs` owns the connection, recording session and shared gesture
scheduler; macOS key names use the existing native key parser (RAlt is right
Option). Recordings and mapped key edges remain independent in both modes.
The native adapter releases held outputs and stops recording on removal,
disconnection, mode/profile changes or disabling the instance. Consumer buttons
with no macOS equivalent (settings/M) remain available for explicit mappings.

macOS decoded PCM goes to that instance's MiRemoteV 2ch bridge in external-input
mode. This mode does not start CoreBluetooth/RC003 discovery. It reuses gain,
output route verification, bounded PCM buffering, tail draining and idle pause.
A new session discards the previous queue. Runtime recording state comes from
the HID recording controller, independently of whether an output is selected.
The macOS UI exposes recording mode, volume calibration and the existing virtual
microphone driver management entry.

macOS implementation validation still requires a Mac: build with Xcode, grant
Input Monitoring/Accessibility, bind A15, select MiRemoteV 2ch, then check hold
and click recording with a simultaneous right-Option mapping. Verify independent
MiRemoteV input capture, releases on disconnect/disable, and reconnect. Current
Windows-side tests cover the real HID session/controller, shared gestures,
record-group isolation and the captured audio codec fixture; they do not certify
macOS hardware behavior.

Validation uses generated G.722.1 tone frames, the inverse ICO transformation and
synthetic FC packets, plus session reset and malformed packet tests. A physical
A15 capture on 2026-10-27 confirmed the 21-byte format and ICO transformation:
all 412 complete groups passed G.722.1 bitstream checks; none passed Siren7 checks.
A single captured 20 ms group is retained as a regression test, including the
four identical reports per fragment observed from the driver. No FFmpeg is used
in the implementation or tests.

The patched Windows app was also verified live through the configured VB-CABLE
endpoint: an independent WinMM recording of `CABLE Output` captured nonzero PCM
(peak 17459 at 16 kHz PCM16), with no new A15 decode errors. The Rust library suite
passed 179 tests, with five existing hardware-dependent tests ignored.

Instance regression tests cover two physical identities, separate HID edges and
mappings, profile switch routing, recording settings, unbinding and PCM delivery.
