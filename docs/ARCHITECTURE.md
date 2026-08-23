# Architecture

```text
RC003 HID keyboard
  -> Interception keyboard class filter driver
  -> interception.dll user-mode API
  -> exact VID/PID device selection
  -> source scan-code lookup (including E0 state)
  -> per-user mapping snapshot
  -> original event, suppressed event, or replacement chord
  -> Interception send on the same RC003 keyboard device
```

The input service sets a filter only on the matching RC003 Interception device.
Other keyboards do not enter Axonkey's event loop and therefore cannot be
suppressed by an RC003 mapping.

Settings are immutable snapshots from the input thread's perspective. The UI
saves a normalized copy and swaps the service snapshot; no process restart or
Windows reboot is involved in a mapping edit.

Interception is a required runtime and driver dependency. Installing or
removing its class filter requires administrator access and a Windows reboot.
Normal Axonkey execution uses the current user's privileges.
