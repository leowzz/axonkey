# Third-party notices

This document records Axonkey's third-party source references, bundled drivers
and codecs, and direct application dependencies. Package versions below are
resolved versions from [package-lock.json](package-lock.json) and
[src-tauri/Cargo.lock](src-tauri/Cargo.lock), checked for Axonkey 2.0.1 on
2026-10-29. Platform-specific components are identified in their entries.

Each component retains its own license. This overview does not enumerate the
entire transitive Rust dependency graph or development-only JavaScript tools;
their versions are recorded in the lockfiles and their license texts accompany
the upstream packages. Repository-relative links refer to the Axonkey source
tree, which is available at [leowzz/axonkey](https://github.com/leowzz/axonkey).

## remote-mic-app

- Project: [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app)
- Upstream license: [GNU General Public License v3.0](https://github.com/HD838A/remote-mic-app/blob/main/LICENSE.md)

Axonkey's product inspiration comes from [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app). Its macOS implementation references the project's RC003 VID/PID, HID usages, ATVV voice protocol, IOKit permission checks, CoreGraphics input injection and Core Audio output paths.

Axonkey maintains its own Tauri interface, settings format, driver builds and runtime services. The projects are independent; Axonkey is not a fork of remote-mic-app.

## remote-bridge-hub

- Project: `xxb26553663-star/remote-bridge-hub`
- Source: [remote-bridge-hub](https://github.com/xxb26553663-star/remote-bridge-hub/tree/8a93f321ac71a602300c6cd77f7256fa4b63068e)
- Reference revision: `8a93f321ac71a602300c6cd77f7256fa4b63068e`
- License: [GNU General Public License v3.0 only (`GPL-3.0-only`)](https://github.com/xxb26553663-star/remote-bridge-hub/blob/8a93f321ac71a602300c6cd77f7256fa4b63068e/LICENSE)

The Xiaomi RC003 ATVV UUIDs, microphone commands, capability parsing, and
IMA/DVI ADPCM decoding order were adapted from this project. Axonkey implements
the macOS Bluetooth audio transport with Apple public frameworks.

## libsiren

- Project: [kakaroto/libsiren](https://github.com/kakaroto/libsiren)
- Author: Youness Alaoui, as recorded in [AUTHORS](vendor/libsiren/AUTHORS)
- Reference revision: `c7724c03d4a6daf4d6dff9e917c14ce5071dce66`
- Bundled source: [vendor/libsiren](vendor/libsiren)
- License: source headers grant GNU Library General Public License version 2
  or later (`LGPL-2.0-or-later`); the preserved [COPYING](vendor/libsiren/COPYING)
  file contains the GNU Lesser General Public License version 2.1.

Axonkey compiles the C sources into a static library through
[src-tauri/build.rs](src-tauri/build.rs). The decoder handles CMIOT-A15 remote
audio as 16 kHz mono PCM using G.722.1 mode. Encoder entry points are used for
synthetic test vectors; application audio input uses the decoder.

Local changes include allocation and bitstream bounds checks, power-table and
category validation, portable byte reads and unsigned noise-generator arithmetic,
and separate G.722.1 encode/decode entry points alongside the original Siren7
API. The Rust adapter serializes access to upstream global codec state.
Implementation notes are retained in [vendor/libsiren/AXONKEY.md](vendor/libsiren/AXONKEY.md)
and [CMIOT_A15_AUDIO.md](src-tauri/src/devices/CMIOT_A15_AUDIO.md).

The original authorship and license headers remain in the vendored source.
Distribution of statically linked binaries is subject to the applicable LGPL
source and relinking-material requirements; this notice does not replace those
materials.

## BlackHole

- Project: `ExistentialAudio/BlackHole`
- Source: [ExistentialAudio/BlackHole](https://github.com/ExistentialAudio/BlackHole)
- Pinned source: `v0.7.1` / `e2b22aaaba4e507a097131704bf96dabc004d9cf`
- License: [GNU General Public License v3.0](https://github.com/ExistentialAudio/BlackHole/blob/e2b22aaaba4e507a097131704bf96dabc004d9cf/LICENSE)

Axonkey builds the separately identified `MiRemoteV2ch.driver` from this pinned
source. `third_party/blackhole/blackhole-device-usb.patch` changes the reported
Core Audio transport to USB and assigns an independent CFPlugIn factory UUID.
The build settings use bundle identifier `com.hd838a.MiRemoteV2ch`, device UID
`MiRemoteV2ch_UID`, and two channels. The driver coexists with BlackHole and is
distributed as a separate macOS Installer component inside Axonkey.app.

The pinned upstream source and local patch are documented in
[third_party/blackhole/README.md](third_party/blackhole/README.md).
The build and installer recipes are
[build-macos-audio-driver.sh](scripts/build-macos-audio-driver.sh) and
[package-macos-audio-driver.sh](scripts/package-macos-audio-driver.sh).

## QuarborUniversalKeyboardDriver

- Project: `QuarborUniversalKeyboardDriver`
- Vendor: 通化奇桦科技有限公司 / Quarbor Logic Technologies Inc.
- Bundled INF driver version: `0.9.1.0` (`DriverVer = 10/24/2026,0.9.1.0`)
- Copyright (c) 2026 通化奇桦科技有限公司 Quarbor Logic Technologies Inc.

Axonkey's Windows bundle includes the vendor installer EXE, INF, driver DLL,
catalog and license under `vendor/QuarborUniversalKeyboardDriverInstaller`.
The repository also contains the vendor SDK, including `SDK/keyboard.proto`,
which is compiled into Rust protocol types at build time. The SDK directory
is not included in the Windows bundle's resource list.

The driver supplies Windows HID capture and virtual input output. RC003 and
CMIOT-A15 remote sessions use per-device Quarbor connections, including A15
recording control and audio reports.

This is proprietary software governed by the vendor's
[Free Use / No Resale License](vendor/QuarborUniversalKeyboardDriverInstaller/License).
The license permits free use and free sharing of the original, unmodified
software with its notices retained. It requires prior written authorization
for commercial distribution or integration into a commercial software product,
and restricts modification and resale. The full vendor license controls these
permissions; Axonkey does not relicense the driver or SDK.

## VB-Audio VB-CABLE Pack45

Copyright (C) 2010-2024 V. Burel / VB-Audio Software. All rights reserved.

Product page: [VB-Audio VB-CABLE](https://vb-audio.com/Cable/)

Licensing and distribution terms: [VB-Audio licensing](https://vb-audio.com/Services/licensing.htm)

Axonkey's Windows bundle includes the official `VBCABLE_Driver_Pack45.zip` package without
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
That license allows redistribution of the unmodified package and requires the
author's agreement to integrate it into another software installation procedure.
Donationware does not mean that the driver is open source.
Additional provenance is recorded in [vendor/vbcable/SOURCE.md](vendor/vbcable/SOURCE.md).

## hidapi

- Rust wrapper: [ruabmbua/hidapi-rs](https://github.com/ruabmbua/hidapi-rs), version 2.6.7, MIT license.
- Native HIDAPI: [libusb/hidapi](https://github.com/libusb/hidapi), version 0.15.0 in the Rust crate's vendored source; available under BSD 3-Clause, GPL v3, or the original HIDAPI license. Its license files are retained under `etc/hidapi/` in the published crate.

Used for supported-device discovery and per-instance HID input sessions.
macOS builds use the native HIDAPI implementation with shared-device support.
Windows builds use the crate's Rust `windows-native` backend; Quarbor-managed
devices use the separate Quarbor protocol described above.

## Frontend libraries

These packages are used by the desktop frontend. License identifiers below
come from the locked packages and their distributed license files.

| Component | Locked version | License | Use in Axonkey |
| --- | --- | --- | --- |
| [React / React DOM](https://github.com/facebook/react) (`react`, `react-dom`) | 18.3.1 / 18.3.1 | MIT | UI components and rendering |
| [Lucide](https://github.com/lucide-icons/lucide) (`lucide-react`) | 0.468.0 | ISC; includes Feather-derived portions under MIT | Interface icons |
| [Reicon](https://github.com/dqev/reicon) (`reicon-react`) | 1.2.0 | MIT | Undo and redo icons |
| [Sequential Workflow Designer](https://github.com/nocode-js/sequential-workflow-designer) (`sequential-workflow-designer`) | 0.40.4 | MIT | Workflow canvas, interactions and styles |
| [Aegis Web SDK](https://www.npmjs.com/package/aegis-web-sdk) (`aegis-web-sdk`) | 1.41.17 | MIT, as declared in the package metadata | Tencent RUM integration |

The frontend lockfile also includes the following production dependencies:

| Component | Locked version | License | Dependency of |
| --- | --- | --- | --- |
| [scheduler](https://github.com/facebook/react) | 0.23.2 | MIT | React DOM |
| [loose-envify](https://github.com/zertosh/loose-envify) | 1.4.0 | MIT | React / React DOM / scheduler |
| [js-tokens](https://github.com/lydell/js-tokens) | 4.0.0 | MIT | loose-envify |
| [sequential-workflow-model](https://github.com/nocode-js/sequential-workflow-model) | 0.2.0 | MIT | Sequential Workflow Designer |
| [web-vitals](https://github.com/GoogleChrome/web-vitals) | 4.2.4 | Apache-2.0 | Aegis Web SDK |

React, React DOM and scheduler retain the copyright notice of Facebook, Inc.
and its affiliates. Sequential Workflow Designer carries Copyright (c) 2022
N4NO.com; Sequential Workflow Model carries Copyright (c) 2023 N4NO.com.
Lucide's license credits Cole Bemis (2013-2022) for Feather-derived portions
and Lucide Contributors (2022) for the remaining work.

The Aegis SDK is initialized only when `TENCENT_RUM_ID` is supplied at build
time. Its published package declares MIT but does not include a standalone
license file; that metadata is the basis of the entry above.

## Tauri and plugins

[Tauri](https://github.com/tauri-apps/tauri) and the
[Tauri plugins workspace](https://github.com/tauri-apps/plugins-workspace)
provide the desktop runtime and native integrations. These packages are
dual-licensed under `MIT OR Apache-2.0`.

| Component | Rust crate version | JavaScript package version |
| --- | --- | --- |
| Tauri / `@tauri-apps/api` | 2.12.5 | 2.12.4 |
| Autostart | 2.7.0 | 2.7.0 |
| Clipboard manager | 2.3.3 | 2.3.3 |
| Dialog | 2.8.4 | 2.8.4 |
| Log | 2.10.1 | 2.10.1 |
| Process | 2.4.0 | 2.4.0 |
| Single instance | 2.4.3 | — |
| Updater | 2.14.1 | 2.14.1 |

Rust plugins use the `tauri-plugin-` prefix; JavaScript plugins use
`@tauri-apps/plugin-`. Tauri's distributed notices credit Tauri Apps
Contributors and The Tauri Programme in the Commons Conservancy.

## Other direct Rust dependencies

The following versions are resolved from `src-tauri/Cargo.lock`. The Windows
entries are enabled by the Windows target section of `src-tauri/Cargo.toml`.

| Component | Locked version | License | Use in Axonkey |
| --- | --- | --- | --- |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 | Data serialization |
| [serde_json](https://github.com/serde-rs/json) | 1.0.151 | MIT OR Apache-2.0 | JSON configuration and messages |
| [semver](https://github.com/dtolnay/semver) | 1.0.28 | MIT OR Apache-2.0 | Release version comparison |
| [log](https://github.com/rust-lang/log) | 0.4.34 | MIT OR Apache-2.0 | Runtime logging |
| [sha2](https://github.com/RustCrypto/hashes) | 0.10.9 | MIT OR Apache-2.0 | SHA-256 hashing |
| [CPAL](https://github.com/RustAudio/cpal) (`cpal`) | 0.18.2 | Apache-2.0 | Windows audio device access and PCM playback |
| [Prost](https://github.com/tokio-rs/prost) (`prost`) | 0.14.4 | Apache-2.0 | Windows Quarbor protocol encoding and decoding |
| [Tokio](https://github.com/tokio-rs/tokio) (`tokio`) | 1.53.1 | MIT | Windows asynchronous named-pipe I/O |
| [windows-rs](https://github.com/microsoft/windows-rs) (`windows`, `windows-collections`) | 0.61.3 / 0.2.0 | MIT OR Apache-2.0 | Windows and WinRT API bindings |
| [winreg](https://github.com/gentoo90/winreg-rs) | 0.55.0 | MIT | Windows registry access |

Direct Rust build dependencies are `tauri-build` 2.7.4 (`MIT OR Apache-2.0`),
[`cc`](https://github.com/rust-lang/cc-rs) 1.4.4 (`MIT OR Apache-2.0`),
`prost-build` 0.14.4 (`Apache-2.0`), and
[`protox`](https://github.com/andrewhickman/protox) 0.10.0 (`MIT OR Apache-2.0`).
They build the desktop application, compile the bundled C/Objective-C sources,
and generate Windows protocol bindings. They are distinct from the separately
installed third-party drivers listed above.
