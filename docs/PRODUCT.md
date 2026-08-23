# Axonkey Product Scope

## Purpose

Axonkey gives one specific physical product, the Xiaomi RC003 Bluetooth
remote, a predictable button-mapping experience on Windows. It is a focused
local utility rather than a general keyboard automation platform.

## First release

- Recognize only keyboard devices whose hardware identifier contains Xiaomi
  vendor `0x2717` and product `0x32B8`.
- Keep the user's normal keyboard isolated from every RC003 mapping.
- Show only remote buttons that produce stable Windows keyboard events.
- Replace a button with a single key or a chord of up to four keys.
- Let the user preserve the original event or disable the button.
- Offer a curated "input text and press Enter" behavior, implemented as paste,
  a 30 ms wait, and Enter.
- Apply saved changes immediately without a reboot.
- Run in the notification area and optionally at sign-in.
- Store all settings and diagnostics locally.
- Guide the user through installing and detecting the optional VB-Audio
  VB-CABLE virtual microphone endpoint.

The RC003 Back and independent Volume +/- buttons are not shown because Windows
does not reliably associate those events with their source input device. Axonkey
therefore cannot prove that an event came from the RC003 without risking input
from another keyboard or remote. They can be added later if a device-specific
event path is validated.

## Defaults

| RC003 button | Default behavior |
| --- | --- |
| Voice / F5 | Right Alt |
| Power / extended `0x015E` | Escape |
| Home, TV, Menu, Enter and directions | Preserve original key |

## Usability rules

- The main window answers three questions without opening another page:
  whether the driver is ready, whether RC003 is connected, and what each
  button currently does.
- Editing a mapping starts from a tabbed, directly visible list of common
  behaviors. Key and shortcut capture share one entry, and no extra add
  confirmation is required.
- Invalid custom shortcuts cannot be saved.
- Missing devices and missing drivers have different messages and remedies.
- A mapping failure must not leave a replacement modifier held down.

## Non-goals for the first release

- Other remote or keyboard models.
- Cloud accounts, configuration sync, telemetry, or remote control over a
  network.
- Mac or Linux support.
- User-authored macro scripts, application-specific profiles, or a general
  automation editor. Curated multi-step behaviors may still be provided.
