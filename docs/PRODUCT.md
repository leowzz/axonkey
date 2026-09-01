# Axonkey Product Scope

> The current Interception-based input path has a confirmed Bluetooth HID
> reconnect blocker and does not yet satisfy this product scope. See
> [Interception hot-plug incident](./INTERCEPTION_HOTPLUG_INCIDENT.md).

## Purpose

Axonkey gives one specific physical product, the Xiaomi RC003 Bluetooth
remote, a predictable button-mapping experience on Windows and macOS. It is a focused
local utility rather than a general keyboard automation platform.

## First release

- Recognize only HID devices with Xiaomi vendor `0x2717` and product `0x32B8`.
- Keep the user's normal keyboard isolated from every RC003 mapping.
- Show ten editable RC003 buttons on Windows and thirteen on macOS.
- Replace a button with a single key or a chord of up to four keys.
- Let the user preserve the original event or disable the button.
- Offer a curated "input text and press Enter" behavior, implemented as paste,
  a 30 ms wait, and Enter.
- Apply saved changes immediately without a reboot.
- Run in the notification area and optionally at sign-in.
- Store all settings and diagnostics locally.
- Guide Windows users through Interception and optional VB-CABLE setup, and
  macOS users through Input Monitoring, Accessibility, and optional MiRemoteV
  2ch virtual-microphone setup.
- Forward physical RC003 voice sessions to MiRemoteV 2ch on macOS without a
  remote-mic-app process or installation.

The RC003 Back and independent Volume +/- buttons are not shown on Windows because
Windows does not reliably associate those events with their source input device.
Axonkey therefore cannot prove that an event came from the RC003 without risking
input from another keyboard or remote. The macOS backend can identify these raw
usages, so macOS exposes them as platform-specific editor rows with native behavior
as their defaults.

## Defaults

| RC003 button | Default behavior |
| --- | --- |
| Voice / F5 | Right Alt |
| Power / extended `0x015E` | Escape |
| Back, Volume +/-, Home, TV, Menu, Enter and directions | Preserve original key |

## Usability rules

- The main window answers three questions without opening another page:
  whether the platform input backend is ready, whether RC003 is connected, and what each
  button currently does.
- Editing a mapping starts from a tabbed, directly visible list of common
  behaviors. Key and shortcut capture share one entry, and no extra add
  confirmation is required.
- Invalid custom shortcuts cannot be saved.
- Missing devices, missing platform drivers and missing macOS permissions have
  different messages and remedies.
- A mapping failure must not leave a replacement modifier held down.
- Installing, closing, or uninstalling Axonkey must not prevent RC003's original
  input after a Bluetooth HID reconnect.

## Non-goals for the first release

- Other remote or keyboard models.
- Cloud accounts, configuration sync, telemetry, or remote control over a
  network.
- Linux support.
- User-authored macro scripts, application-specific profiles, or a general
  automation editor. Curated multi-step behaviors may still be provided.
