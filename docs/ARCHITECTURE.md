# Architecture

```text
Windows
  RC003 BTHLEDEVICE parent
    -> QuarborUniversalKeyboardDriver per-device binding
    -> duplex per-instance Universal v1 pipe (Tokio + prost)
    -> exact VID/PID device selection
    -> RC003 BTHLE report decoding (Report ID + little-endian usage slots)
    -> mapping snapshot, gesture state and shared held-key counts
    -> driver-supported standard keys -> keysend -> independent synthetic HID output
    -> media / unsupported keys and connected chords -> SendInput virtual keys
    -> SendInput cursor movement, mouse clicks, wheel and Unicode text
    -> validated application / website system launches

  RC003 ATVV voice service
    -> Windows Bluetooth GATT control and audio notifications
    -> Rust frame accumulator and 16 kHz IMA ADPCM decoder
    -> CPAL output to CABLE Input
    -> CABLE Output selected by the consuming application

macOS
  RC003 HID interfaces
    -> IOHIDManager exact VID/PID matching
    -> report ID 1, little-endian HID usage set
    -> exclusive capture, or CGEventTap suppression fallback
    -> mapping snapshot and gesture state
    -> CoreGraphics keyboard/unicode events or AppKit system-key events

  RC003 ATVV voice service
    -> CoreBluetooth control and audio notifications
    -> Rust frame accumulator and 16 kHz IMA ADPCM decoder
    -> AVAudioEngine bound to MiRemoteV 2ch output
    -> MiRemoteV 2ch input selected by the consuming application
```

The input service discovers the RC003 `BTHLEDEVICE` parent, computes the Quarbor pipe hash, and accepts only frames from that instance. Other keyboards do not enter Axonkey's event loop and therefore cannot be suppressed by an RC003 mapping.

The Windows Universal client is implemented in Rust. `protox` and `prost-build` generate
types from the vendor schema without protoc; Tokio handles the duplex pipe,
and the `windows` crate is used only for native system input/output APIs. The
BTHLEDEVICE source has a passive vendor descriptor, so RC003 physical reports
are decoded directly from their Report ID and little-endian usage slots.
Driver-supported standard remote keyboard actions use semantic keysend commands
with correlated Result responses. Unmapped/disabled inputs forward their
original keyboard usages. Media/volume keys and unsupported output usages use
SendInput virtual keys.
Chords containing virtual keys and other chords sharing those keys use the same virtual backend.
Down edges remember the selected backend; cancellation, capture failures and shutdown release virtual keys too.
All remote behavior types enter the scheduler, including delayed sequences,
wheel holds and explicit disabled actions. An unconfigured single click still forwards the
original key when only double/long press is mapped. Cursor movement, mouse clicks, wheel and
Unicode text use SendInput; application/website actions use validated system launches.
Independent system mouse mappings keep their SendInput backend.
The driver blocks physical input and releases its injected state on disconnect.
See [the Universal input design](quarbor-v3-read.md) for framing, recovery and validation.

On macOS, the input service starts in non-exclusive monitor mode. When custom
mappings are enabled and both Input Monitoring and Accessibility permissions
are available, it first requests exclusive device access. If exclusive access
is unavailable, it keeps a monitored device open and arms a short-lived
CGEventTap match from each RC003 HID edge. Only the corresponding native event
is suppressed; generated Axonkey events carry a private marker and bypass the
filter. This keeps native remote behavior intact during onboarding or after
permissions are revoked. Back and Volume +/- are device-specific raw usages on
macOS, so they enter the same mapping and gesture state machine as the other ten
buttons. Their preserve-original behavior emits Delete or AppKit system-volume
events with the remote's native repeat timing.

Settings are immutable snapshots from the input thread's perspective. The UI
saves a normalized copy and swaps the service snapshot; no process restart or
system reboot is involved in a mapping edit. On macOS, changing the master
enabled state restarts only the IOHIDManager session so it can enter or leave
capture mode safely.

Installing or removing Quarbor requires administrator access. Normal Axonkey execution uses the current user's privileges. Quitting Axonkey closes the Quarbor pipe client and releases mapped outputs.

The macOS backend is compiled from `native/macos_input.m` and
`native/devices/xiaomi_remote/macos_audio.m` and links only Apple system frameworks. Input Monitoring
authorizes raw HID reports; Accessibility authorizes event filtering and
generated keyboard events; the Bluetooth usage description covers the separate
ATVV voice connection. macOS needs no input driver. Its optional virtual audio
driver is a pinned BlackHole derivative built and packaged by Axonkey as
`MiRemoteV2ch.driver`.

`AudioServiceManager` is the application-facing audio module on both platforms.
It owns one `AudioService` per RC003 instance, keyed by `instanceId`; each
service owns its Bluetooth session, frame accumulation, ADPCM decoder, gain,
PCM queue and diagnostics. Rust owns frame accumulation, ADPCM decoding, gain,
and audio diagnostics. On Windows, each service uses Windows Bluetooth GATT
APIs and CPAL to forward voice to its configured output; when available, the
GATT selector is filtered by the bound Bluetooth address. On macOS, each
service owns an Objective-C adapter that hides CoreBluetooth,
ATVV session control, AVAudioEngine device binding, reconnect timeouts and
sleep-safe audio-engine lifetime. The macOS service prepares Core Audio output
when RC003 voice capabilities are confirmed and reuses the configured engine
between presses. After five idle seconds it pauses IO while retaining the graph;
disconnect and shutdown release the output. A bounded single-producer,
single-consumer PCM ring feeds an AVAudioSourceNode, with a 30 ms prebuffer and
2 ms fades at underruns. The render callback performs no allocation, logging,
or blocking synchronization; the main queue collects rendered-sample counters.

The legacy setup page and the Windows CMIOT A15 recorder retain a compatibility
audio service. Their commands omit `instanceId`; RC003 instance settings and
calibration commands include it and are routed to that instance's service.

Long presses can still exhibit approximately 1.8–2 seconds of cumulative delay
and missing speech at release on RC003 firmware 2671. The investigation is
paused; see [measurements, limitations, and shelved experiments](RC003_AUDIO_LATENCY.md).
The experimental background queue and post-stop packet handling are not part of
the current implementation and must not be described as confirmed fixes.

The first-run guide presents Quarbor and VB-CABLE on one driver setup page. Tauri invokes the bundled QuarborUniversalKeyboardDriverInstaller.exe directly. Its --list JSON provides binding and recovery state without elevation; --install targets the online RC003 BTHLEDEVICE parent and lets the installer request UAC. App uninstall invokes --uninstall-all so the installer can restore online and offline instances, including legacy Quarbor bindings, before removing its published packages. The installer owns package staging and restoration; the UI uses its rebootRequired result and accepts exit code 3010 as success requiring a reboot.
The upstream Pack45 ZIP is bundled without modification, and Axonkey verifies
the archive hash, extracted x64 installer hash, and Authenticode publisher
signature before requesting elevation. Driver readiness is detected from the
`VBAudioVACMME` Windows service rather than from unrelated sound devices.
Platform resources remain split between `tauri.windows.conf.json` and
`tauri.macos.conf.json`. macOS builds generate signed install/uninstall PKGs
from the pinned source before Tauri embeds them; the app invokes the macOS
Installer engine with explicit administrator authorization and refreshes the
audio service afterward.
