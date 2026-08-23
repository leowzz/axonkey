# Architecture

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
```

The input service sets a filter only on the matching RC003 Interception device.
Other keyboards do not enter Axonkey's event loop and therefore cannot be
suppressed by an RC003 mapping.

On macOS, the input service starts in non-exclusive monitor mode. When custom
mappings are enabled and both Input Monitoring and Accessibility permissions
are available, it first requests exclusive device access. If exclusive access
is unavailable, it keeps a monitored device open and arms a short-lived
CGEventTap match from each RC003 HID edge. Only the corresponding native event
is suppressed; generated Axonkey events carry a private marker and bypass the
filter. This keeps native remote behavior intact during onboarding or after
permissions are revoked. When capture is active, unsupported Back and Volume
usages are forwarded to their native Delete/system-volume equivalents.

Settings are immutable snapshots from the input thread's perspective. The UI
saves a normalized copy and swaps the service snapshot; no process restart or
system reboot is involved in a mapping edit. On macOS, changing the master
enabled state restarts only the IOHIDManager session so it can enter or leave
capture mode safely.

On Windows, Interception is a required runtime and driver dependency. Installing or
removing its class filter requires administrator access and a Windows reboot.
Normal Axonkey execution uses the current user's privileges.

The macOS backend is compiled from `native/macos_input.m` and links only Apple
system frameworks: IOKit, CoreFoundation, ApplicationServices and AppKit. It
does not install a driver. Input Monitoring authorizes raw HID reports;
Accessibility authorizes event filtering and generated keyboard events.

The first-run guide presents Interception and VB-CABLE on one driver setup page
so both installers can finish before the user reboots Windows once. It can
launch the official VB-Audio VB-CABLE installer.
The upstream Pack45 ZIP is bundled without modification, and Axonkey verifies
the archive hash, extracted x64 installer hash, and Authenticode publisher
signature before requesting elevation. Driver readiness is detected from the
`VBAudioVACMME` Windows service rather than from unrelated sound devices.
Windows-only resources live in `tauri.windows.conf.json`; macOS bundles exclude
them through `tauri.macos.conf.json`.
