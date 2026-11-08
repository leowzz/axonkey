# Axonkey Product Scope

## Purpose

Axonkey is a local device-mapping tool for Windows and macOS. It lets users
configure shortcuts, text input, and multi-step actions for supported remotes,
game controllers, and system mouse inputs. Device support can grow through
additional device integrations; available inputs and platform requirements
depend on the selected device.

## Current features

- Discover supported devices and keep each physical device's binding,
  configuration, and runtime state separate.
- Keep ordinary keyboard input outside device mappings; device reports are
  matched to the bound device instance.
- Show the selected device's editable inputs and available trigger types.
- Configure system mouse buttons, scrolling, and screen-edge actions.
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
- Guide Windows users through required per-device input-driver setup and optional Quarbor Virtual Microphone setup, and
  macOS users through Input Monitoring, Accessibility, and optional MiRemoteV
  2ch virtual-microphone setup.
- Forward voice from supported devices to Quarbor Virtual Microphone on Windows
  and MiRemoteV 2ch on macOS. Voice transport and decoding run inside Axonkey.
- Adjust voice gain from -30 dB to +30 dB and inspect live audio levels.
- Show device connection, battery, permissions, and driver status, with setup
  actions and access to local runtime logs.

## Defaults

New device instances start with a blank default profile. Imported or migrated
configurations retain their saved mappings. System mouse inputs preserve their
original behavior until a mapping is configured.

## Usability rules

- The home page shows added and discovered devices, connection state, battery
  when available, and the active profile. Each device workspace provides
  input editing and its own runtime status.
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

- Devices without a corresponding integration, and ordinary keyboard remapping.
- Cloud accounts, configuration sync, telemetry, or remote control over a
  network.
- Linux support.
- User-authored macro scripts, application-specific profiles, or a general
  automation editor. The mapping editor supports sequences of the built-in
  behavior types.
