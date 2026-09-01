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

## Interception 1.0.1

Copyright (C) 2008-2017 Francisco Lopes da Silva.

Upstream project: https://github.com/oblitum/Interception

Release: https://github.com/oblitum/Interception/releases/tag/v1.0.1

Axonkey dynamically loads the unmodified AMD64 `interception.dll` and uses only
the published Interception API. The release package also carries the upstream
command-line driver installer so installation and removal remain explicit user
actions.

The upstream project describes Interception as dual-licensed. For
non-commercial purposes, it states that the library and source use LGPL and
that related driver/installer binaries may be distributed when communication
with the drivers occurs solely through the library and its API. Commercial use
requires one of the commercial licenses described by the upstream project.

The full non-commercial LGPL text shipped in the v1.0.1 archive is included at
`vendor\interception\LICENSE-LGPL-3.0.txt`. The upstream commercial-license
documents are retained in the source tree under
`vendor\interception\licenses` for review; their presence does not grant a
commercial license.

Reviewed binary hashes (SHA-256):

- x64 `interception.dll`: `AB88164C11B1B48488772D4C3BFAA4509D5B0AE9DBC5A691DC4F96F0260443C8`
- `install-interception.exe`: `E137863A79DA797F08E7A137280FF2A123809044A888FD75CE9C973198915ABE`

The upstream installer does not carry an Authenticode publisher signature.
Axonkey verifies its exact reviewed hash before installation or removal and
never invokes it silently.

Axonkey does not bundle or require AutoHotkey or AutoHotInterception.

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
