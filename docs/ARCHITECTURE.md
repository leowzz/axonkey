# Architecture

> **Migration status:** the Windows backend now talks directly to
> OpenInputBridge and rejects legacy Interception by requiring the OIB service
> pair and `OIB1` driver identity. The implementation addresses the known
> lifecycle cause, but production safety still depends on the unexecuted RC003
> reconnect matrix in [Windows alternatives](./WINDOWS_INPUT_ALTERNATIVES.md).

```text
Windows
  RC003 HID keyboard
    -> OpenInputBridge KMDF keyboard filter
    -> direct OIB control-device IOCTLs
    -> OIB identity and dynamic keyboard-slot validation
    -> exact VID/PID device selection
    -> source scan-code lookup (including E0 state)
    -> mapping snapshot and gesture state
    -> OIB write on the selected RC003 slot

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

The input service opens every keyboard control slot reported by OpenInputBridge,
reads the hardware ID for each slot, and sets a filter only on the matching RC003.
Other keyboards do not enter Axonkey's event loop and therefore cannot be
suppressed by an RC003 mapping. Slot numbers are temporary: after the target HID
node disappears, Axonkey clears held outputs, closes the complete OIB context,
waits for a stable RC003 PnP node, then opens a new context and scans hardware
IDs again. It never caches the old slot across reconnects.

Each OIB context owns one exclusive file handle and one queue event per keyboard
slot. `IOCTL_SET_FILTER` captures the selected slot, `IOCTL_READ` receives its
standard `KEYBOARD_INPUT_DATA`, and `IOCTL_WRITE` releases original or mapped
records. Closing the file handles is the driver contract for removing filters;
therefore disabling mappings, losing the target, exiting, or crashing releases
the capture without relying on a persistent global slot table.

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

Installing or removing OpenInputBridge requires administrator access and a
Windows reboot. Normal Axonkey execution uses the current user's privileges.
The app checks both `OpenInputBridgeKeyboard` and `OpenInputBridgeMouse` service
keys before opening protocol-compatible control paths, then requires the OIB-only
identity response. A residual Interception installation is therefore reported
as unsupported rather than used as a fallback.

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

The first-run guide presents OpenInputBridge and VB-CABLE on one driver setup page
so both installers can finish before the user reboots Windows once. It can
launch the official vendor installers. The OIB action requires both driver
halves, verifies the Applet LLC installer signature and Microsoft WHQL catalog
signatures, and enables upstream access auditing and toast notifications.
Windows release builds fail before packaging if the separately licensed OIB
WHQL files are absent.
The upstream Pack45 ZIP is bundled without modification, and Axonkey verifies
the archive hash, extracted x64 installer hash, and Authenticode publisher
signature before requesting elevation. Driver readiness is detected from the
`VBAudioVACMME` Windows service rather than from unrelated sound devices.
Platform resources remain split between `tauri.windows.conf.json` and
`tauri.macos.conf.json`. macOS builds generate signed install/uninstall PKGs
from the pinned source before Tauri embeds them; the app invokes the macOS
Installer engine with explicit administrator authorization and refreshes the
audio service afterward.
