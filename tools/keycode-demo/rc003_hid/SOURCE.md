# RC003 HID tap provenance

Adapted from ZSTDJan/windows-remote-mic-app, revision
`ca1d4946a4336ba517e4e2c633f21077ceae82d9`, under GPL-3.0-only:
https://github.com/ZSTDJan/windows-remote-mic-app/tree/ca1d4946a4336ba517e4e2c633f21077ceae82d9/apps/windows/rc003/src/ovb_rc003

Copyright (C) 2026 Remote Mic contributors.

Copied modules: `frida_compat.py`, `frida_hid_tap_runtime.py`,
`frida_hid_tap_injector.py`, and `device_profile.py`.
The upstream attributes this technique to `xxb26553663-star/remote-bridge-hub`.
The full GPL license is in `LICENSE-GPL-3.0.txt`. This experimental helper and
its Axonkey modifications are distributed under GPL-3.0-only.

Axonkey changes (2026-09-09): independent package entry point and runtime path,
revision-specific loopback port and Gadget identity, reject ambiguous RC003 instances, filter each I/O handle by the
RC003 service's current NT device object even in a shared WUDFHost, record UMDF
proxy reports as explicitly unverified without mapping them, preserve complete reports and
unknown usages in diagnostics, detach the hook when the receiver disconnects.
The Gadget DLL remains resident until Windows recycles its WUDF host.

Frida Gadget 17.15.3 is downloaded unchanged from its official GitHub release.
Both the XZ archive and extracted DLL are checked against the pinned SHA-256
values in `frida_hid_tap_runtime.py`. `LICENSE-Frida.txt` retains the upstream
license (wxWindows Library Licence 3.1). Corresponding source:
https://github.com/frida/frida-core/tree/17.15.3

This helper is an experiment; it is not included in Axonkey's application
installer or production input backend.
