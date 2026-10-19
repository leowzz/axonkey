# Axonkey Product Scope

## Purpose

Axonkey gives one specific physical product, the Xiaomi RC003 Bluetooth
remote, a predictable button-mapping experience on Windows and macOS. It is a focused
local utility rather than a general keyboard automation platform.

## Current features

- Recognize only HID devices with Xiaomi vendor `0x2717` and product `0x32B8`.
- Keep ordinary keyboard scan codes outside RC003 mappings; Quarbor reports are
  matched to the current RC003 device instance.
- Show thirteen editable RC003 buttons on Windows and macOS.
- Read Back and Volume +/- directly from Quarbor HID reports on Windows.
- Configure click, double-click, long-press, and direct replacement actions independently.
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
- Guide Windows users through Quarbor HID per-device setup and optional VB-CABLE setup, and
  macOS users through Input Monitoring, Accessibility, and optional MiRemoteV
  2ch virtual-microphone setup.
- Forward RC003 voice to VB-CABLE on Windows and MiRemoteV 2ch on macOS.
  Voice transport and decoding run inside Axonkey.
- Adjust voice gain from -30 dB to +30 dB and inspect live audio levels.
- Show device connection, battery, permissions, and driver status, with setup
  actions and access to local runtime logs.

The Windows backend decodes the RC003 usages `0xF1`, `0x80`, and `0x81` from the
Quarbor report stream alongside the other ten buttons. No secondary capture
process, preference, or administrator authorization is needed for these keys.

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
