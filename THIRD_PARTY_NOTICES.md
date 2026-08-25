# Third-party notices

## remote-bridge-hub

- Project: `xxb26553663-star/remote-bridge-hub`
- Source: https://github.com/xxb26553663-star/remote-bridge-hub
- Reference revision: `8a93f321ac71a602300c6cd77f7256fa4b63068e`
- License: GNU General Public License v3.0 only (`GPL-3.0-only`)

The Xiaomi RC003 ATVV UUIDs, microphone commands, capability parsing, and
IMA/DVI ADPCM decoding order were adapted from this project. Axonkey implements
the macOS transport with Apple public frameworks and does not include the
upstream Windows input-injection or application code.

## BlackHole

- Project: `ExistentialAudio/BlackHole`
- Source: https://github.com/ExistentialAudio/BlackHole
- Pinned source: `v0.7.1` / `e2b22aaaba4e507a097131704bf96dabc004d9cf`
- License: GNU General Public License v3.0 (`GPL-3.0`)

Axonkey builds the separately identified `MiRemoteV2ch.driver` from this pinned
source. `third_party/blackhole/blackhole-device-usb.patch` changes the reported
Core Audio transport to USB and assigns an independent CFPlugIn factory UUID.
The build settings use bundle identifier `com.hd838a.MiRemoteV2ch`, device UID
`MiRemoteV2ch_UID`, and two channels. The driver coexists with BlackHole and is
distributed as a separate macOS Installer component inside Axonkey.app.

The exact build recipe and corresponding-source pointer are retained at
`third_party/blackhole/README.md`.

## OpenInputBridge 1.00

Copyright (C) 2026 OpenInputBridge Contributors.

Upstream project: https://github.com/Applet-LLC/OpenInputBridge

Release: https://github.com/Applet-LLC/OpenInputBridge/releases/tag/1.00

Reviewed source commit: `a661848ddf4deadc07e6c6df9d374c20df5f4c01`

OpenInputBridge's original source is MIT licensed. Axonkey implements its
user-mode protocol client directly from the published protocol documentation;
it does not load or bundle `interception.dll`. The upstream MIT text is retained
at `vendor\openinputbridge\LICENSE-MIT.txt`.

The production WHQL driver package is a separately sold and licensed artifact.
It is not present in this repository. A Windows release must not be distributed
until Axonkey has written OEM/redistribution permission and records the approved
package version, hashes, and signer identities in
`vendor\openinputbridge\SOURCE.md`. The Windows build preflight rejects an
incomplete package. At install time Axonkey also requires an Applet LLC-signed
installer and Microsoft Windows Hardware Compatibility Publisher-signed
keyboard and mouse catalogs.

Legacy Interception 1.0.1 binaries and license evidence remain in the source
tree only for uninstall/recovery and incident provenance. New Axonkey Windows
packages do not include them, and production code rejects them as an input
backend. Axonkey does not bundle or require AutoHotkey or AutoHotInterception.

## VB-Audio VB-CABLE Pack45

Copyright (C) 2010-2024 V. Burel / VB-Audio Software. All rights reserved.

Product page: https://vb-audio.com/Cable/

Licensing and distribution terms: https://vb-audio.com/Services/licensing.htm

Axonkey distributes the official `VBCABLE_Driver_Pack45.zip` package without
modification and launches its x64 setup program only after an explicit user
action. VB-CABLE is Donationware. Users who find it useful or use it
professionally are invited to donate or purchase a license from VB-Audio.

Installing or removing VB-CABLE requires administrator permission and a Windows
reboot. Axonkey verifies the package SHA-256, the extracted installer SHA-256,
and the installer's Authenticode publisher signature before launching it.

Reviewed binary hashes (SHA-256):

- `VBCABLE_Driver_Pack45.zip`: `B950E39F01AF1D04EA623C8F6D8EB9B6EA5C477C637295FABF20631C85116BFB`
- Packaged `VBCABLE_Setup_x64.exe`: `734C35DFA6D98F48782A451633CEB471166EC70D60482FD89A1123D0EE3C4F41`

The upstream package contains its complete end-user license in `readme.txt`.
Additional provenance is recorded in `vendor/vbcable/SOURCE.md`.
