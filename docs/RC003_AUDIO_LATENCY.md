# RC003 cumulative audio delay investigation — 2026-09-16

Status: paused at the user's request; unresolved on the physical remote. The user still hears approximately
1.8–2 seconds of delay during long presses and reports missing speech at release.
Do not describe the application-side changes as a verified fix for this symptom.

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
