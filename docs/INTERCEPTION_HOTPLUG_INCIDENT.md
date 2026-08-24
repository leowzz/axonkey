# Interception hot-plug incident

- Status: confirmed release blocker
- Observed on: Windows 11 x64, Axonkey 0.1.4 and 0.1.5
- Recorded: 2026-08-24

## Summary

The bundled Interception 1.0.1 keyboard class filter is not safe for the
RC003 Bluetooth HID lifecycle. After the remote disconnects, sleeps, is reset,
is forgotten, or is paired again, Windows can recreate its HID keyboard node
without Interception registering a usable keyboard slot. The device still
appears healthy in Windows, but no key events reach applications.

The failure persists when Axonkey is not running. Recreating or delaying the
Axonkey user-mode Interception context does not repair the kernel device stack.

## User impact

- RC003 can show as connected and have an `OK` HID keyboard node while every
  button produces no input.
- Closing Axonkey does not restore the original button behavior.
- Restarting Windows can restore input temporarily, but the next Bluetooth HID
  disconnect/reconnect can trigger the failure again.
- Other keyboards are also exposed to a global keyboard upper-filter driver,
  even though Axonkey only requests events from the RC003 device.

## Reproduction

1. Install Interception and restart Windows.
2. Pair RC003 and confirm that its buttons produce keyboard input.
3. Let RC003 enter its idle disconnect cycle, or reset/forget and pair it again.
4. Wait for Windows to recreate the RC003 HID keyboard child.
5. Observe that the device is present and healthy, but its buttons no longer
   produce input with Axonkey either open or closed.

The tested RC003 also performs an idle cycle approximately every 52 seconds.
Its HID keyboard child disappears for about 4-7 seconds while the Bluetooth
parent and HID-over-GATT service remain present. This normal device behavior
makes the Interception hot-plug defect repeatable without manually removing the
device.

## Evidence

After a failed reconnect, Windows reported the RC003 keyboard node as present,
with no problem code, and the following device stack:

```text
\Driver\kbdclass
\Driver\keyboard       (Interception upper filter)
\Driver\kbdhid
\Driver\mshidumdf
```

A read-only `interception_get_hardware_id` probe showed other keyboards in
slots 1-5 and empty slots 6-10. RC003 was absent from every Interception slot
despite its Windows HID keyboard node being present. The filter was therefore
attached to the device stack without exposing a working input slot.

This behavior matches upstream reports:

- [Interception issue #93](https://github.com/oblitum/Interception/issues/93):
  a reconnected keyboard becomes unresponsive even when the client application
  is not running.
- [Interception issue #25](https://github.com/oblitum/Interception/issues/25):
  repeatedly connected devices stop producing input until Windows restarts.
- [Interception issue #193](https://github.com/oblitum/Interception/issues/193):
  later analysis of the fixed device-slot and reconnect limitation.

Separate `BTHUSB` event 18 entries were observed while Windows failed to store
the RC003 Bluetooth link key. Removing the device and pairing again cleared the
rapid authentication loop, but it did not remove the periodic HID reconnect or
the Interception hot-plug risk.

## Root cause and rejected mitigations

The fault is inside the installed Interception kernel filter's PnP/hot-plug
handling. It is not caused by Axonkey's VID/PID matching, connection polling,
mapping state, or application shutdown cleanup.

The following user-mode mitigations were implemented and found insufficient:

- an 8-second visible connection grace period;
- periodic Windows PnP detection;
- rebuilding the Interception context after target loss;
- waiting for a stable HID keyboard node before creating a context;
- clearing all Interception filters when Axonkey exits.

These changes can reduce UI flicker or avoid competing with pairing, but they
cannot repair a kernel filter that mishandles a newly enumerated keyboard.

## Recovery

The safe recovery path is:

1. Exit Axonkey and every other Interception client.
2. Run the repository uninstall script from an elevated prompt:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-driver.ps1
   ```

3. Restart Windows. A shutdown followed by power-on is not equivalent when
   Fast Startup is enabled.
4. Forget RC003 in Windows Bluetooth settings and pair it again.
5. Verify the original buttons before installing another input filter.

Removing Interception disables Axonkey's current device-specific custom mapping
engine. Restarting without removing Interception is only a temporary recovery.

## Required product work

Axonkey must not claim reliable RC003 input or automatic default-input recovery
while Interception 1.0.1 remains installed. A production replacement must:

- carry a valid Windows kernel signature suitable for normal Secure Boot
  systems;
- support repeated Bluetooth HID removal and arrival without fixed-slot leaks;
- identify and filter only RC003;
- pass input through when Axonkey is disabled, closed, or crashes;
- survive reset, forget/pair, sleep/wake, and at least 100 reconnect cycles;
- have licensing terms that permit Axonkey distribution.

[OpenInputBridge](https://github.com/Applet-LLC/OpenInputBridge) is a
protocol-compatible, PnP-aware candidate. Its source is MIT-licensed, but its
project documentation states that generally usable WHQL-signed driver binaries
are paid distribution artifacts. Integration therefore requires binary access,
licensing, signature, and redistribution review before it can replace the
bundled driver.

A user-mode-only implementation would avoid the kernel failure, but Windows
does not provide reliable global suppression of one keyboard device through
Raw Input alone. Such an implementation would need an explicit product decision
about allowing the original RC003 action to pass through alongside a custom
action.

## Release gate

Do not close this incident based only on connection status or a short manual
test. The replacement input path must pass the reconnect tests above on a clean
Windows installation, and uninstalling Axonkey must leave RC003's original
input behavior functional.
