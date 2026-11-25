# Axonkey License Scope and GPLv3 Section 7 Additional Permission

Copyright (C) 2026 Axonkey contributors (<https://github.com/leowzz/axonkey>)

## 1. License Version (`GPL-3.0-only`)

Axonkey is free software: you can redistribute it and/or modify it under the
terms of the **GNU General Public License as published by the Free Software
Foundation, version 3 only (`GPL-3.0-only`)** — and **not** any later version
(see Section 14 of the GNU General Public License, version 3).

The full text of the GNU General Public License, version 3 is preserved in
[`LICENSE`](LICENSE).

## 2. Scope and Third-Party Exclusions

`GPL-3.0-only` applies solely to Axonkey's original source code, scripts,
documentation, and assets in this repository. It does **not** alter or
relicense third-party source code, codecs, drivers, or binary installers
contained in or referenced by this repository. Each third-party component
retains its own license, as recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), including:

- [`vendor/QuarborUniversalKeyboardDriverInstaller/`](vendor/QuarborUniversalKeyboardDriverInstaller)
  and [`vendor/QuarborVirtualMicrophoneDriverInstaller/`](vendor/QuarborVirtualMicrophoneDriverInstaller)
  — proprietary software by 通化奇桦科技有限公司 / Quarbor Logic Technologies
  Inc., governed by the vendor's *Free Use / No Resale License*
  ([keyboard driver license](vendor/QuarborUniversalKeyboardDriverInstaller/License),
  [microphone driver license](vendor/QuarborVirtualMicrophoneDriverInstaller/License))
- [`vendor/libsiren/`](vendor/libsiren) — `LGPL-2.0-or-later` / `LGPL-2.1`
- [`vendor/obesbc/`](vendor/obesbc) — BSD 2-Clause license
- [`third_party/blackhole/`](third_party/blackhole) — `GPL-3.0`

## 3. Additional Permission under GNU GPL Version 3 Section 7 (Quarbor Windows Driver and SDK Exception)

As a special exception under Section 7 of the GNU General Public License,
version 3, the copyright holders of Axonkey give you permission to compile
Axonkey (for Windows targets) with, link or combine Axonkey with, and
distribute Axonkey alongside the unmodified `QuarborUniversalKeyboardDriver`
and `QuarborVirtualMicrophoneDriver` packages and the Quarbor protocol schema
([`vendor/QuarborUniversalKeyboardDriverInstaller/SDK/keyboard.proto`](vendor/QuarborUniversalKeyboardDriverInstaller/SDK/keyboard.proto),
compiled into Rust protocol types at build time) under Quarbor Logic
Technologies Inc.'s *Free Use / No Resale License*, and to distribute the
resulting combination without requiring those Quarbor components to be licensed
under the GNU General Public License, version 3.

This Additional Permission is subject to the following terms:

1. **No grant of proprietary rights**: This Additional Permission grants no
   rights under Quarbor Logic Technologies Inc.'s proprietary license. Anyone
   using, copying, bundling, or redistributing any Quarbor driver, installer,
   binary, or SDK component must independently comply with Quarbor's *Free Use
   / No Resale License*, including obtaining prior written commercial
   authorization from Quarbor Logic Technologies Inc. for commercial
   distribution, paid distribution, OEM pre-installation, hardware bundling, or
   commercial software/SDK integration.
2. **Axonkey code remains `GPL-3.0-only`**: All source code of Axonkey other than
   the unmodified Quarbor components remains governed by `GPL-3.0-only`. If you
   modify or extend Axonkey, you must still make the complete corresponding
   source code of Axonkey (excluding the unmodified Quarbor components covered
   by this exception) available under `GPL-3.0-only`.
3. **Removal of this exception**: Pursuant to Section 7 of the GNU General
   Public License, version 3, if you copy or modify Axonkey without including
   or relying on the Quarbor components, you may remove this Additional
   Permission from your copy or modified version and distribute it purely under
   `GPL-3.0-only`.
