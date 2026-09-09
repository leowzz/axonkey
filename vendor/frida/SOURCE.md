# Frida Gadget and Windows extra keys

Frida Gadget **17.15.3**, Windows x86-64, unmodified.

- Release: https://github.com/frida/frida/releases/tag/17.15.3
- Download: https://github.com/frida/frida/releases/download/17.15.3/frida-gadget-17.15.3-windows-x86_64.dll.xz
- Corresponding source: https://github.com/frida/frida-core/tree/17.15.3
- XZ SHA-256: `b566d70189b6d551ad8f4e0bea24de08a3d4c0f559bb35b2bdb67d45182240c2`
- DLL SHA-256: `6fca4007b2284c765a6c15c967a741f536b5865bf83867326a54029a3b752748`
- License: wxWindows Library Licence 3.1; see `LICENSE-Frida.txt`.

`frida-gadget.dll` is embedded in the Windows executable at build time. The
optional elevated helper verifies its hash and extracts it to a protected,
revision-specific directory under `%ProgramData%\Axonkey\extra-keys`. Nothing is
downloaded at runtime; no Python installation or new kernel driver is required.
The DLL stays resident until Windows recycles WUDFHost. Its script detaches the
hooks when the helper disconnects. Closing Axonkey's main window keeps the tray
session alive; turning off the feature or quitting ends the helper session.
Reconnect commands require a random credential readable only by Administrators,
SYSTEM and the LocalService host. An ordinary local listener cannot reactivate
the resident script after the user turns the feature off.

The HID observation technique and Gadget script are adapted from
ZSTDJan/windows-remote-mic-app, commit
`ca1d4946a4336ba517e4e2c633f21077ceae82d9`:
https://github.com/ZSTDJan/windows-remote-mic-app/tree/ca1d4946a4336ba517e4e2c633f21077ceae82d9/apps/windows/rc003/src/ovb_rc003

Copyright (C) 2026 Remote Mic contributors. Upstream attributes the technique
to xxb26553663-star/remote-bridge-hub. The adapted script and native HID helper
sources are provided under GPL-3.0-only; see `LICENSE-GPL-3.0.txt`. Retain these
notices and provide corresponding source when distributing the derived work.

Axonkey's corresponding sources are `src-tauri/native/windows/rc003_hid_gadget.js`
and `src-tauri/src/input_service/{windows_extra_keys,extra_keys_winapi,extra_keys_protocol}.rs`.
They replace the experimental Python runtime with a native Rust helper,
explicit UAC activation, authenticated local IPC, automatic extra-key stream
selection, per-handle lifetime tracking, and disconnect cleanup. The complete
application source and build instructions are in https://github.com/leowzz/axonkey
(use the revision accompanying the distributed application).

UMDF proxy names are not physical hardware identities. A shared WUDFHost is
validated against RC003's HID service, then the first eligible nine-byte report
containing Back, Volume+ or Volume- automatically selects the current stream.
That first press is forwarded immediately; no confirmation taps are consumed.
Only that stream's three usages enter the mapping worker. Selection is never
persisted across connections; close, host/device changes, protocol failure and
process exit invalidate it. Another device sharing the host and emitting the
same format and usages first can still be misidentified. Automatic acquisition
is not proof of a proxy's VID/PID. No raw reports from unselected streams are
saved or forwarded to the UI.
