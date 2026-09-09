# Axonkey Product Scope

## Purpose

Axonkey gives one specific physical product, the Xiaomi RC003 Bluetooth
remote, a predictable button-mapping experience on Windows and macOS. It is a focused
local utility rather than a general keyboard automation platform.

## Current features

- Recognize only HID devices with Xiaomi vendor `0x2717` and product `0x32B8`.
- Keep ordinary keyboard scan codes outside RC003 mappings; the optional shared
  UMDF capture channel has the device identity limitation described below.
- Show thirteen editable RC003 buttons on Windows and macOS.
- Optionally enable Back and Volume +/- on Windows with explicit administrator
  authorization, with automatic stream acquisition and no confirmation taps.
- Keep this enhancement off by default and outside the Home readiness checklist.
  Mapping's collapsed Advanced options explain DLL injection, uncertain game
  anti-cheat compatibility, and DLL residency before the user enables it.
- Configure click, double-click, and long-press actions independently.
- Map buttons to keys, modifier keys, shortcuts, media controls, pasted text,
  or a sequence of actions and delays.
- Let the user preserve the original event or disable the button.
- Offer a curated "input text and press Enter" behavior, implemented as paste,
  a 30 ms wait, and Enter.
- Apply saved changes immediately without a reboot.
- Keep running in the Windows notification area or macOS menu bar when the
  main window is closed.
- Import and export mappings as JSON, restore defaults, and undo or redo edits.
- Store all settings and diagnostics locally.
- Guide Windows users through Interception and optional VB-CABLE setup, and
  macOS users through Input Monitoring, Accessibility, and optional MiRemoteV
  2ch virtual-microphone setup.
- Forward RC003 voice to VB-CABLE on Windows and MiRemoteV 2ch on macOS.
  Voice transport and decoding run inside Axonkey.
- Adjust voice gain from -30 dB to +30 dB and inspect live audio levels.
- Show device connection, battery, permissions, and driver status, with setup
  actions and access to local runtime logs.

The RC003 Back and independent Volume +/- buttons require optional support on Windows. The
known raw Keyboard-page usages (0xF1, 0x80, 0x81) do not produce scan codes in the
tested Windows HID translation function, so adding scan-code mappings is insufficient.
An elevated Frida helper reads their raw reports. The first eligible extra-key
report selects a stream for the current connection and immediately executes its
mapping. Shared UMDF proxies are not verified physical identities: another device
in the same host with the same report format and usages can be misidentified.
The old v1 preference is not migrated: the user must opt in again after seeing
the disclosure, then the v2 preference remembers that choice. If both the saved extra-key switch
and custom mappings are enabled, startup automatically requests UAC once after
restoring native settings. Cancellation leaves a manual retry option; subsequent
mapping edits, imports and settings synchronization do not repeat the prompt.
See [the Windows diagnosis](./WINDOWS_RC003_EXTRA_KEYS.md) for evidence and limits.
The macOS backend can identify these raw usages, so macOS exposes them as
platform-specific editor rows with native behavior as their defaults.

## Defaults

| RC003 button | Default behavior |
| --- | --- |
| Voice / F5 | Right Alt |
| Power / extended `0x015E` | Escape |
| Back, Volume +/-, Home, TV, Menu, Enter and directions | Preserve original key |

## Usability rules

- The home page shows input readiness, RC003 connection and battery, audio
  status, and whether custom mappings are enabled. The mapping page provides
  per-button editing.
- Editing a mapping starts from a tabbed, directly visible list of common
  behaviors. Key and shortcut capture share one entry, and no extra add
  confirmation is required.
- Invalid custom shortcuts cannot be saved.
- Missing devices, missing platform drivers and missing macOS permissions have
  different messages and remedies.
- A mapping failure must not leave a replacement modifier held down.
- Closing the main window keeps mappings active; disabling custom mappings or
  quitting the application releases input capture.

## Outside the supported scope

- Other remote or keyboard models.
- Cloud accounts, configuration sync, telemetry, or remote control over a
  network.
- Linux support.
- User-authored macro scripts, application-specific profiles, or a general
  automation editor. The mapping editor supports sequences of the built-in
  behavior types.
