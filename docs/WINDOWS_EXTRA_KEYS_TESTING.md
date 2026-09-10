# Windows extra-key integration validation

Implementation branch: `codex/rc003-frida-hid-tap`.

The packaged Windows app embeds Frida Gadget and starts its own native helper
with `ShellExecuteExW` / `runas`. This replaces Python for production; the older
standalone diagnostic remains available for comparison.

## Automated checks (2026-09-10)

- `npm run tauri build -- --bundles nsis`: passed, including pinned DLL hash check.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 30 passed.
- `npm run test:release`: 26 passed; 3 macOS execution tests skipped on Windows.
- `node --test test/windows-extra-keys-gadget.test.mjs`: passed.
- Historical browser inspection: authorization explanation and switch visible on Home and
  Mapping; all 13 buttons present; Back exposes click/double-click/long-press.

The current tests exercise immediate delivery of each extra key's first press,
ignoring ordinary/idle reports before acquisition, rejection of other streams
and malformed packets, simultaneous usages, duplicate suppression,
modifier release, cancellation of pending clicks, timer-based long presses,
raw-output cleanup, per-handle close/reuse, authenticated configuration,
completed-read filtering, idle detach and reconnect.

Windows release-test fixtures also normalize line endings and use Git Bash
instead of system32/bash.exe (WSL), so explicit versions and the injected git
failure preserve their intended environment. No release/tag command was run
against this working repository.

## Native physical capture verified (2026-09-10)

After initializing COM on the authorization thread and accepting both REG_QWORD
and REG_DWORD for the device's WUDF `HostPid`, the native smoke test passed with
the user's RC003. The user confirmed that the Windows authorization window was
visible. The helper passed its administrator check and connected to the current
WUDFHost. Three complete confirmation taps advanced the state from pairing
steps 0, 1, 2 to ready at step 3. A second round produced:

```text
KEY back DOWN
KEY back UP
KEY volumeUp DOWN
KEY volumeUp UP
KEY volumeDown DOWN
KEY volumeDown UP
```

The test exited successfully and the native helper exited on session shutdown.
This run used the embedded DLL and native Rust helper, without Python. It
captured events without executing mappings. The first attempt had stalled at
authorization; a later attempt revealed that this Windows installation stores
`HostPid` as REG_QWORD, which previously caused false device-absent detection.

## Reconnect regression fixed and verified (2026-09-10)

The installed build subsequently timed out 15 seconds after entering pairing.
The native debug capture reproduced the failure without the UI. TCP inspection
showed two simultaneous WUDFHost connections to the same helper port. Overlapping
asynchronous reconnect attempts could overwrite the active output stream, so
the helper configured one socket while readiness and heartbeats went to another.
A global write queue could also hold up a replacement connection behind an old
socket's pending write.

The regression test failed before the fix (three concurrent connection attempts
instead of one) and passed afterward. The script now allows only one connection
attempt in flight, gives each connection its own bounded write queue, closes
disconnected sockets, and ignores failures from previous sessions. The native
helper waits for a valid ready/heartbeat acknowledgment before displaying the
three-key confirmation instructions.

The patched DLL script captured all six DOWN/UP edges from the user's three
keys again. A second, separately elevated helper then reused the resident DLL
without restarting Windows. It reached confirmed pairing and stayed healthy
for more than 45 seconds without key presses, with exactly one established
WUDFHost connection. The idle probe was then stopped and its helper exited.
The Gadget regression and all 11 Rust input-service tests passed; the NSIS
installer was rebuilt. Installed UI mapping outputs remain part of the checks
below.

## Gesture output timing (2026-09-10)

The user's runtime log at 01:04:49–01:04:59 showed Volume- double-click and
timer-triggered long-press recognition, followed by successful Esc down/up
submissions. Thus gesture recognition was working in that trace. The output
implementation immediately released synthesized taps, unlike single-click
mappings which remained down until physical release. A polling application
could miss these short pulses; this remains a candidate explanation pending
confirmation in the user's target application.

Synthesized key/chord taps and deferred default clicks now hold for 50 ms before
releasing. Physical single-click holds retain their previous behavior. Regression
coverage loads all three keys' mappings from JSON, triggers double-click and
long-press, and verifies exactly one Esc pulse (no Space click or duplicate)
with an observable down interval. It failed before the change and passed after;
all 11 Rust input-service tests passed. Target-application physical acceptance
of this timing change still needs verification.

## UAC cancellation and white-screen recovery (2026-09-10)

The reported white screen coincided with a development Fast Refresh at 01:10:14:
React raised `Should have a queue` from the App hook list. The native log then
recorded normal UAC cancellation at 01:10:15. App updates now request a fresh
React mount instead of preserving the old hook layout. A root error boundary
can also remount a damaged tree once; repeated render errors show a recovery
button rather than an empty window.

Automatic authorization is consumed once per native application process,
including after cancellation or disabling support. A webview remount cannot
reopen the prompt, while an explicit retry can. Restarting the application still
automatically requests UAC when the saved switches are enabled.

Three React renderer tests cover UAC No through status polling, command rejection,
and cancellation combined with a damaged render tree. They verify the other UI
controls remain usable, the saved switch persists, manual retry works, and
recovery does not open another dialog. Both native authorization lifecycle tests
also passed (13 input-service tests in total). These automated tests do not
operate the Windows secure-desktop consent dialog.

## Automatic activation (2026-09-10)

The confirmation flow described in the historical physical runs above has been
removed. A healthy Gadget acknowledgment now publishes ready before processing
any following key in the same read batch. The first qualifying extra-key report
acquires its stream and forwards its down edge immediately. Closing that handle
clears acquisition and resets pending gestures/outputs; the next qualifying
press automatically acquires the new stream. See the opt-in placement update
below for the current UI.

Protocol regression tests cover starting with any of the three keys, duplicate
reports, other streams, simultaneous keys, releases, and acquisition after close.
The React readiness test requires no simulated button presses or confirmation
actions. Physical mapping acceptance in the target application remains separate
from these automated checks.

`npm run test:windows-extra-keys` passed: 5 Node tests (Gadget and React) and
14 Rust input-service tests, including the existing double-click/long-press and
UAC cancellation regressions. TypeScript and the production frontend build also
passed. The updated flow has not undergone a new physical target-application run.

## Default-off enhancement and contextual guidance (2026-09-10)

The control is now in Mapping's collapsed Advanced options, with a contextual
link when Back or either volume key is selected. It is absent from Home and the
required setup checklist. The expanded control discloses Frida DLL injection,
uncertain game anti-cheat compatibility, and the need to restart Windows if the
user wants to clear an already loaded DLL after disabling support.

The v2 preference defaults to false and deliberately does not inherit a true v1
value. Users must explicitly opt in after this disclosure. The false startup
path stops any helper left alive across frontend remounts without requesting
UAC; informed opt-in retains automatic authorization on later launches.
The 7 Node tests and 14 Rust input tests passed, including fresh/legacy defaults,
explicit opt-in, persistence, cancellation recovery, and disabling across a
remount. TypeScript and Vite compilation passed. Browser UI automation could not
run in this session because the connector rejected the configured API-key auth;
the new layout has not been visually inspected in a live browser.

## Extra-key latency (2026-09-10)

The user's Volume+ → Enter trace already showed a mapped hold immediately after
the mapper received down. It did not establish physical end-to-end latency:
log timestamps had only second precision. Review found two avoidable sources
of delay upstream: both TCP hops used default Nagle behavior, and Frida events
could sit in a queue while the mapping worker waited up to 50 ms for an
Interception event that these three usages never generate.

Every Gadget connection now awaits `setNoDelay(true)` before capture starts,
including reconnects. Failure closes that socket before retrying. All native IPC
sockets use `TCP_NODELAY` too. Frida documents Nagle as enabled by default in its
[SocketConnection API](https://frida.re/docs/javascript-api/#socketconnection).
The mapping worker requests an 8 ms wait while extra-key capture is ready and
retains 50 ms otherwise. The 100 ms socket read timeout remains an idle health
deadline; complete reports are returned immediately without batching.

The Gadget regression failed before this change and passed afterward.
`npm run test:windows-extra-keys` passed with 7 Node tests and 15 Rust input tests.
Coverage verifies immediate down output for each of the three keys with a key
or shortcut mapping, including disabled double/long rows, and retains existing
gesture, release, cancellation and reconnect checks. The loopback test uses two
real TCP connections in one process: 100 small reports measured median 48 us,
p95 126 us and maximum 210 us in one run, with no release or following packet
needed to deliver a press. It also checks partial and multiple JSON frames.
These measurements exclude BLE, the actual Gadget runtime, worker scheduling,
Interception output and the target application; no physical latency reduction
has yet been measured. The shorter wait is not an end-to-end latency guarantee.

## Visible activation guidance (2026-09-10)

When enhancement is off, the three affected key tiles now show `需开启增强`.
Selecting one displays a highlighted explanation that its mapping is not active
and that saving a mapping does not enable enhancement. The explicit
`查看说明并开启` button opens Advanced options without requesting UAC. The
disclosure then offers `开启并授权`, alongside the existing switch. Cancellation
and connection failures retain a visible status/authorization entry; once ready,
the warning changes to enabled status and tile requirements disappear.

`npm run test:windows-extra-keys` passed with 8 Node tests and 15 Rust tests.
The new React test verifies that opening the disclosure does not authorize
injection, explicit activation requests UAC, cancellation preserves unavailable
guidance, and ready status clears that guidance. README and Windows input docs
use the same labels. Live visual inspection remains outstanding.

## Remaining interactive checks

With the installed build, verify:

1. Verify a fresh install and an old v1=true preference both stay off without
   UAC. Open Mapping → Advanced options, read the disclosure, and enable custom
   mappings and the extra-key switch. Cancel UAC: the UI explains
   cancellation and offers retry; the other ten keys continue working.
2. Authorize and wait for ready without pressing keys. The first normal press of
   any extra key must execute its mapping; there is no confirmation sequence.
3. Configure one click, double-click and long-press action; verify the physical
   outputs. With no custom action, verify browser Back and system Volume +/-.
4. Hold a replacement modifier and turn the feature off; verify release. Quit
   through the tray and verify that the helper exits and the hook detaches.
5. Restart with both switches enabled: UAC should appear automatically once,
   after native settings are restored. Cancel: it must not repeat on polling or
   mapping edits, and manual retry must remain available. Restart with extra keys
   off, or with custom mappings off: no automatic UAC. Reconnect the remote:
   the next normal press must work without confirmation.
6. Try another keyboard/remote alongside RC003. Automatic report matching is not
   proof of physical hardware identity; see the scope limits in
   [Windows input](./WINDOWS_INPUT.md) and [provenance](../vendor/frida/SOURCE.md).

For a capture-only native test, a debug build supports
`axonkey.exe --extra-keys-smoke-test`. It requests UAC and observes a normal tap
of each key in any order without sending mapped output. It exits after those
events or after 120 seconds. This is a developer diagnostic, not a product setup
step.
