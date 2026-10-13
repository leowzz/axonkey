# RC003 cumulative audio delay investigation — 2026-09-16

Status: investigation resumed on 2026-10-13 after another report of stuttering;
unresolved on the physical remote. The September report included approximately
1.8–2 seconds of delay during long presses and missing speech at release.
Do not describe the application-side changes as a verified fix for these symptoms.

## Follow-up — 2026-10-13

The user confirms that the **same RC003 and Axonkey on Windows** do not exhibit
the obvious stutter/delay. This is a useful host comparison, but no simultaneous
Windows packet-rate measurements are available. The installed macOS app reports
0.3.25; MiRemoteV2ch.driver reports 0.7.1. Source inspection at 6b0fbd3 shows both
platforms send the same capability request (`0a 01 00 00 03 03`) and share the
16 kHz ADPCM decoder. Windows prebuffers 20 ms and macOS 30 ms; that difference
does not account for seconds of missing delivery.

Evidence from `~/Library/Logs/com.axonkey.app/axonkey.log`, sessions 60–63 around
11:22–11:23 China time, excluding windows containing START/STOP and keeping
950–1050 ms windows:

| Session | Observed seconds | Received packets/s | Decoded audio seconds | Queue exhaustions/s | Largest packet gap | Largest sampled queue |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 60 | 5.997 | 45.69 | 4.110 | 8.50 | 88.1 ms | 30.0 ms |
| 61 | 4.998 | 45.22 | 3.390 | 8.60 | 104.7 ms | 32.3 ms |
| 62 | 14.994 | 45.89 | 10.320 | 9.00 | 89.6 ms | 28.0 ms |
| 63 | 12.993 | 43.48 | 8.475 | 8.54 | 119.9 ms | 30.0 ms |

All these windows have zero enqueue failures, discarded pending buffers,
notification read errors, rejected packets, and codec syncs. Each packet carries
120 bytes / 240 samples / 15 ms; realtime delivery requires 66.67 packets/s.
Session 63 therefore supplies only about 65% of realtime PCM. These are delivery
deficits, **not a measured packet-loss percentage or end-to-end delay**. Queue
sizes are periodic snapshots, not continuous maxima. First packet / first render
for session 63 occur 17.1 / 48.1 ms after the application session starts; this is
not measured from the physical button press or at the receiving application.

Independent macOS unified logs from bluetoothd between 11:20:00 and 11:24:20
contain 92 `HID lag issue is detected` messages for VID 0x2717 / PID 0x32b8,
matching RC003. This corroborates a contemporaneous Bluetooth/HID issue but does
not identify the ATVV cause or distinguish radio retries, controller scheduling,
remote buffering, and application callback scheduling. The filtered logs did not
provide current connection interval, MTU, or retransmission counts; the September
values below must not be treated as October measurements.

The supplied `~/Downloads/axon麦克风卡顿.m4a` is approximately 15.3 seconds,
48 kHz stereo AAC. FFmpeg decoding at the original stereo rate produced 1,466,240
scalar samples, **all exactly zero**. Mono decoding also produced only zeros.
It cannot establish the audible stutter or acoustic latency; its creation metadata
alone cannot align its capture interval to a voice session.

Current evidence locates a sufficient cause of discontinuous output before the
virtual driver's input: the source PCM queue repeatedly runs out because too
little audio arrives. A separate downstream fault is not excluded. The historical
driver-only loopback measurement below is evidence against blaming MiRemoteV
alone, but was not repeated today. Increasing prebuffering cannot repair sustained
delivery at 43–46 packets/s and would add delay.

Next discriminating measurements are a matching Windows diagnostics sample and a
macOS controller/GATT trace aligned with application callback timestamps. A fresh
remote connection and a controlled mapping-enabled/disabled comparison can test
connection state and HID interaction; no such comparison has yet been performed.
Avoid claiming a specific Bluetooth driver or firmware defect without that evidence.

Validation: `node --test test/macos-audio-tail-drain.test.mjs` passed both native
tests, including PCM queue AddressSanitizer/UndefinedBehaviorSanitizer coverage.
This verifies queue behavior, not physical Bluetooth delivery. No production code,
driver installation, or shelved experiment was changed during that initial check.

### Subsequent speaker feedback and silent recording

At approximately 11:31 the user reported hearing remote speech through the real
output after quitting QuickTime. QuickTime was absent from the process list.
Read-only Core Audio process/device snapshots during two reproductions showed
Axonkey as the only active audio-output process and EDIFIER W820NB as the active
device, while MiRemoteV was idle. The initial snapshots used the global scope for
per-process device lists (which returned empty); device activity and process
activity were observed separately. This establishes a downstream routing problem
in addition to the receive-rate deficit, and explains how recording MiRemoteV can
produce silence. It does not establish when or what redirected the engine.

The existing Settings → Device and permissions → Restart driver action was run
at 11:32:37. The user confirmed feedback disappeared. Subsequent snapshots at
11:34:19 and 11:34:34, using the correct output scope, showed Axonkey outputting
to device 113, MiRemoteV 2ch. Doubao IME was also observed with input active.
This verifies recovery of routing, not resolution of Bluetooth stuttering.

The source now resolves `MiRemoteV2ch_UID` again before resuming a paused engine,
explicitly selects its current device ID, and verifies both the selected ID and
UID before and after starting. It does not trust an old numeric ID after driver
reload. An atomic render gate outputs silence without consuming queued PCM until
post-start verification succeeds. Missing devices, binding/read-back errors, and
start failures stop the output and surface an error. A running graph or resumed
graph redirected elsewhere is stopped and rebuilt. Normal resume preserves the
graph and queued PCM. Core Audio property strings now release their owned CF
reference because identity verification also runs on the active enqueue path.

All three native audio/queue/battery tests and 16 Rust audio-service tests passed.
Regression cases cover changed IDs, running/resume redirection, startup silence,
preserved PCM, and missing-device/bind/read-back/start failures. A temporary native
probe using the production bridge also passed three real Core Audio cycles on this
Mac: pause its own empty graph, redirect that graph to the real default output,
resume, and verify it selects MiRemoteV while retaining the same engine. The probe
sent no audio, captured none, and did not alter the system default devices. It
does not reproduce actual driver reload or explain the original trigger.

The source change has not yet replaced the installed app; immediate recovery used
its existing restart operation. Bluetooth throughput remains a separate issue.

## Runtime evidence

- RC003 firmware 2671 negotiates ATVV 1.0, ADPCM 16 kHz, 120-byte frames.
  Each frame decodes to 240 samples / 15 ms. Sustained realtime delivery requires
  about 66.7 frames per second.
- Sessions 68–72 typically delivered 45–65 frames per second. The application
  output queue usually held less than 40 ms. Enqueue failures, output discards,
  rejected packets, and AUDIO_SYNC events were zero in these observed sessions.
- Moving the remote within 20–30 cm did not remove the reported delay.
- No post-stop packets were observed in these sessions. Accepting late packets
  and preserving the ADPCM decoder across STOP were defensive experiments, not
  evidence that the reported lost speech has been recovered. Both are shelved.
- macOS negotiated ATT MTU 247 and link data length 251; the connection interval
  was 15 ms with peripheral latency zero. A missing MTU/DLE negotiation is not
  supported by this evidence.

## Isolated measurements on the user's machine

Temporary native probes sent synthetic signals and retained only timing metrics,
not microphone recordings. Measurements cover software delivery, not headphone
acoustic output. The production-bridge probe ran against the experimental
background-queue version before shelving; it does not establish identical
scheduling under UI load for the restored main-queue version.

| Path | Observation |
| --- | --- |
| MiRemoteV output → MiRemoteV input | 22 seconds, 2,060 observations; per-second mean 10.75–10.79 ms, no growth |
| MiRemoteV output → QuickTime monitor process output | 22 seconds; per-second means about 190–209 ms, no growth to 1.8 seconds |
| Production AKMacAudioBridge enqueue → MiRemoteV input | After a 3-second warmup, all 19 synthetic markers arrived in 36–46.4 ms, no enqueue failures |

The QuickTime probe used a quiet amplitude ramp and a process-specific Core Audio
tap. Estimating timestamps from the ramp slope becomes noisy at larger amplitudes;
the per-second means, rather than individual extrema, are the useful evidence.
The first engine probe had extra detections during startup and was inconclusive;
the warmed-up run above had exactly 19 transmitted and 19 received markers.

## Experiments that did not establish a fix

- Moving Bluetooth, decode, and output scheduling to a dedicated serial queue did
  not resolve the physical symptom. The change and its main-thread independence
  test are shelved together.
- ATVV on-request mode with MIC_OPEN playback mode was accepted by the remote,
  but the user still heard about 1.8 seconds of delay. That mode and its HID
  start/stop integration were reverted; the remote again negotiated HTT (0x03).
- A temporary, runtime-only CoreBluetooth low-latency request changed the actual
  connection interval to 30 ms, not a shorter interval. It was not added to the
  application. Reconnection restored the original 15 ms interval, confirmed in
  bluetoothd at 20:51:02.640. No private connection API remains in project code.

## Remaining uncertainty

The observations point upstream of decoded PCM enqueue, toward the remote / BLE
delivery path. They do not establish whether the cause is firmware buffering,
radio retransmission, or host Bluetooth scheduling. There is no frame sequence
number in this remote's headerless audio notifications and no AUDIO_SYNC in the
observed sessions, so received-byte deficits alone cannot distinguish delayed
audio from discarded audio. Do not infer an exact remote buffer size from the
user's approximately 2-second estimate.

Further useful evidence would be a comparison with the same remote on another
host, or a Bluetooth controller trace with retransmission / connection-event
statistics. Increasing the local playback buffer or discarding local PCM is not
supported by the current evidence and risks making speech completeness worse.

## Shelved code and current baseline

At the user's request, all remaining uncommitted latency experiments and their
associated tests were removed from the working tree and preserved in a local
Git stash. This is not a released fix.

- Stash commit: `9919dfb790c4f64c91e2ff4fe92e5d0062d59643`
- Stash message: `wip: RC003 cumulative latency experiments (unresolved, 2026-09-16)`
- Files: `src-tauri/native/macos_audio.m`,
  `src-tauri/src/audio_service/macos.rs`, `test/macos-audio-tail-drain.m`,
  `test/macos-pcm-queue.c`.
- Contents: the dedicated worker and dispatch timers, 300 ms late-tail handling,
  decoder preservation across STOP, diagnostic additions, and associated tests.
- Inspect with `git stash show -p 9919dfb790c4f64c91e2ff4fe92e5d0062d59643`.
  Recover deliberately with `git stash apply 9919dfb790c4f64c91e2ff4fe92e5d0062d59643`;
  do not automatically restore these experiments when resuming unrelated work.

The previously committed fixes remain: `2451ca4` reuses the macOS audio output
engine, and `d22b0b0` renders through the real-time PCM ring. The user confirmed
that these resolved the original startup delay and persistent crackling. The
later cumulative-delay symptom remains open. The reverted on-request-mode
experiment and temporary private-API probes are not in the stash or active code;
their outcomes are recorded above.

After shelving, the restored code passed 16 Rust audio-service tests and 3 native
audio tests (including the PCM queue checks under AddressSanitizer and
UndefinedBehaviorSanitizer). The development app rebuilt and reconnected to the
remote. Only this investigation record and its architecture-document link remain
as working-tree changes; the code changes are in the stash.
