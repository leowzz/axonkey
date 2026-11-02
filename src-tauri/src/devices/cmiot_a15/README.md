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

Decoded PCM frames contain:

- `group`: source little-endian group ID.
- `sample_rate`: 16000.
- `samples`: 320 signed integer samples, in time order (20 ms).
- `headers`: original bytes 1..4 of the three reports.
- `tail`: eight auxiliary payload bytes; their meaning remains unknown.

Windows forwards decoded PCM directly to that instance's `AudioService` through
`AudioServiceManager`, without starting the RC003 BLE voice worker. Every A15 and
RC003 has its own gain, PCM queue and streaming resampler. One global Windows
worker mixes these sources by addition, limits clipping, encodes the current
driver PCM16/PCM24 mono/stereo format and sends it directly through
`IOCTL_VMIC_WRITE_PCM` to `\\.\QuarborVirtualMicrophone`. The old Windows playback
endpoint path is no longer used, and no output selection is required. Stopping
one source clears only its own queue. Data is discarded while the driver is
disconnected or its capture stream is not running, so opening a recording app
does not replay old speech. Forwarding does not depend on a frontend event
listener. No audio file is written and no speech recognition is performed.

Recording status is part of each instance's runtime snapshot; Windows transitions also
emit `axonkey-device-recording` with `{ instanceId, recording }`. Audio connection
status follows that instance's driver channel and remains connected between
recordings, allowing gain calibration to finish after recording stops.

The Windows native pending queue is capped at 32 frames, dropping the oldest on overflow;
each instance's audio queue retains the existing two-second sample limit. Decode
errors are rate-limited in the audio log.

The Windows sender refills toward 20 ms of driver FIFO using whole 10 ms blocks,
rounding the deficit up and limiting writes by available FIFO space. A fractional
FIFO remainder must not suppress the next block: rounding down can strand decoded
audio in the application while the driver repeatedly runs short. When enough
source data is available, the resulting FIFO duration is at least 20 ms and below
30 ms, independently of source packet boundaries.

Start/stop, disconnect, transport loss and mode changes reset session state.
On Windows, a missing HID report releases mapped keys and resynchronizes audio.
Click recording remains active across report gaps and retains the physical voice
button state, so a repeated pressed report cannot become a second click. Hold
recording stops on a gap because its release may have been lost. Actual pipe/read
errors, disabling, shutdown and mode changes continue to stop recording.
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

Before the direct driver integration, a Windows hardware test through VB-CABLE
captured nonzero A15 PCM (peak 17459 at 16 kHz PCM16) with no new decode errors.
That historical result validates the decoder; it does not validate the new
`QuarborVirtualMicrophone` transport, which requires a separate hardware capture.

Instance regression tests cover two physical identities, separate HID edges and
mappings, profile switch routing, recording settings, unbinding and PCM delivery.
