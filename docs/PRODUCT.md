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
- Apply saved changes immediately without a reboot.
- Run in the notification area and optionally at sign-in.
- Store all settings and diagnostics locally.

The RC003 Back and independent Volume +/- buttons are not shown because the
validated Windows Bluetooth input path does not report events for them. They
can be added later if a stable hardware event is observed.

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
- Editing a mapping is a direct row action. No modes or programming syntax are
  required for common actions.
- Invalid custom shortcuts cannot be saved.
- Missing devices and missing drivers have different messages and remedies.
- A mapping failure must not leave a replacement modifier held down.

## Non-goals for the first release

- Other remote or keyboard models.
- Cloud accounts, configuration sync, telemetry, or remote control over a
  network.
- Mac or Linux support.
- Macro scripts, application-specific profiles, or multi-step automation.
