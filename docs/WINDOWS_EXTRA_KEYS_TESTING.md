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
- Browser inspection: authorization explanation and switch visible on Home and
  Mapping; all 13 buttons present; Back exposes click/double-click/long-press.

The new tests exercise three complete confirmation taps, rejection of mixed
streams and malformed packets, simultaneous usages, duplicate suppression,
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

## Remaining interactive checks

With the installed build, verify:

1. Enable custom mappings and the extra-key switch. Cancel UAC: the UI explains
   cancellation and offers retry; the other ten keys continue working.
2. Authorize, then tap/release Back, Volume+, Volume- in order. These confirmation
   taps do not execute actions. Repeat the keys after the status becomes ready.
3. Configure one click, double-click and long-press action; verify the physical
   outputs. With no custom action, verify browser Back and system Volume +/-.
4. Hold a replacement modifier and turn the feature off; verify release. Quit
   through the tray and verify that the helper exits and the hook detaches.
5. Restart the app: saved preference must show the authorization button without
   popping UAC automatically. Reconnect the remote: re-confirm the stream.
6. Try another keyboard/remote alongside RC003. UMDF stream confirmation is user
   selection, not automatic hardware identity; see the scope limits in
   [Windows input](./WINDOWS_INPUT.md) and [provenance](../vendor/frida/SOURCE.md).

For a capture-only native test, a debug build supports
`axonkey.exe --extra-keys-smoke-test`. It requests UAC, waits for the three
confirmation taps, then observes a further tap of each key without sending any
mapped output. It exits after those events or after 120 seconds.
