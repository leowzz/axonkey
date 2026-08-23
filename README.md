# Axonkey

Axonkey is a small Windows desktop app dedicated to the Xiaomi RC003 Bluetooth
remote (`VID 0x2717`, `PID 0x32B8`). It intercepts that physical device through
the Interception driver and replaces its buttons with user-selected keyboard
actions. It does not depend on AutoHotkey or AutoHotInterception.

The initial product is intentionally simple:

- one supported device model, RC003;
- a clear connected/disconnected state;
- editable button-to-key mappings;
- mapping changes that take effect without rebooting Windows;
- local settings and diagnostics only.

## System requirements

- 64-bit Windows 10 or Windows 11;
- Xiaomi RC003 paired as a Bluetooth input device;
- .NET Framework 4.8;
- Interception v1.0.1 driver installed once with administrator permission.

Axonkey is compiled as x64 because the bundled native Interception runtime is
the AMD64 build.

## First-time setup

From a source checkout or an unpacked `dist` directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-driver.ps1
```

In an unpacked release, a user can instead double-click `install-driver.cmd`.
Axonkey's in-app install action opens that same reviewed entry point.

The script verifies the reviewed installer hash, explains the system change,
requires typing `INSTALL`, and then asks Windows for administrator permission.
Reboot Windows once after the driver is installed. This reboot is required by
the filter driver, not by Axonkey's mapping configuration.

After that first reboot, adding, deleting, or changing mappings does not require
another reboot. Restart or reload Axonkey only if the UI does not apply a change
immediately.

## Build and test

Axonkey uses the .NET Framework 4.8 compiler included with Windows on this
development machine. No .NET SDK restore and no AutoHotkey installation are
required.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test.ps1
```

The build creates `dist` with:

- `Axonkey.exe` and the x64 `interception.dll` runtime;
- the reviewed Interception driver installer;
- explicit install/uninstall scripts;
- license, source provenance, and third-party notices.

Run Axonkey with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run.ps1
```

or launch `dist\Axonkey.exe` directly.

## Driver removal

Close Axonkey and other Interception-based tools, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-driver.ps1
```

The script requires typing `UNINSTALL` and administrator permission. Reboot
Windows once after removal. Removing the driver disables Axonkey's device-level
blocking.

An unpacked release also provides `uninstall-driver.cmd` at its root.

## Privacy and recovery

Settings and logs are stored under `%LOCALAPPDATA%\Axonkey`. Axonkey does not
send input history or configuration over the network. If a mapping is
uncomfortable, exit Axonkey from its window or tray icon; the Interception
context is then released and ordinary key input passes through.

## Interception licensing

Interception is a separate third-party component and is dual-licensed. Its
upstream project permits non-commercial use under its stated LGPL terms and
requires a separate license for commercial use. Do not commercially distribute
Axonkey with the bundled Interception assets until the appropriate license has
been obtained from the Interception author.

See `THIRD_PARTY_NOTICES.md` and `vendor\interception\SOURCE.md` for exact
versions, hashes, bundled license texts, and upstream links.
