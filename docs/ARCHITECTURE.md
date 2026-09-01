# Architecture

> **Confirmed blocker:** Interception 1.0.1 can leave a reconnected Bluetooth
> HID keyboard present but unable to produce input, even when Axonkey is not
> running. The current Windows input architecture is not production-safe for
> RC003. See [Interception hot-plug incident](./INTERCEPTION_HOTPLUG_INCIDENT.md).

```text
Windows
  RC003 HID keyboard
    -> Interception keyboard class filter driver
    -> interception.dll user-mode API
    -> exact VID/PID device selection
    -> source scan-code lookup (including E0 state)
    -> mapping snapshot and gesture state
    -> Interception send on the same RC003 keyboard device

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

The input service opens the Interception context, reads the hardware ID for each
keyboard slot, and sets a filter only on the matching RC003.
Other keyboards do not enter Axonkey's event loop and therefore cannot be
suppressed by an RC003 mapping. This user-mode isolation does not prevent the
Interception kernel driver's fixed-slot and PnP failure documented in upstream
[issue #25](https://github.com/oblitum/Interception/issues/25).

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

Installing or removing Interception requires administrator access and a Windows
reboot. Normal Axonkey execution uses the current user's privileges. User-mode
context cleanup cannot recover an Interception device that failed during PnP
re-enumeration.

The macOS backend is compiled from `native/macos_input.m` and
`native/macos_audio.m` and links only Apple system frameworks. Input Monitoring
authorizes raw HID reports; Accessibility authorizes event filtering and
generated keyboard events; the Bluetooth usage description covers the separate
ATVV voice connection. macOS needs no input driver. Its optional virtual audio
driver is a pinned BlackHole derivative built and packaged by Axonkey as
`MiRemoteV2ch.driver`.

`AudioService` is the application-facing audio module. Rust owns frame
accumulation and ADPCM decoding; the Objective-C adapter hides CoreBluetooth,
ATVV session control, AVAudioEngine device binding, reconnect timeouts and
sleep-safe audio-engine lifetime. The service starts with the app, but opens
Core Audio IO only while RC003 is sending voice data.

The first-run guide presents Interception and VB-CABLE on one driver setup page
so both installers can finish before the user reboots Windows once. It can
launch the reviewed Interception installer and the official VB-Audio installer.
The Interception scripts verify the bundled installer and runtime hashes before
requesting elevation.
The upstream Pack45 ZIP is bundled without modification, and Axonkey verifies
the archive hash, extracted x64 installer hash, and Authenticode publisher
signature before requesting elevation. Driver readiness is detected from the
`VBAudioVACMME` Windows service rather than from unrelated sound devices.
Platform resources remain split between `tauri.windows.conf.json` and
`tauri.macos.conf.json`. macOS builds generate signed install/uninstall PKGs
from the pinned source before Tauri embeds them; the app invokes the macOS
Installer engine with explicit administrator authorization and refreshes the
audio service afterward.
