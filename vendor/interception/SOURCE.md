# Interception binary provenance

Component: Interception 1.0.1 by Francisco Lopes da Silva

Upstream repository: https://github.com/oblitum/Interception

Upstream release: https://github.com/oblitum/Interception/releases/tag/v1.0.1

The files in this directory were selected from the upstream v1.0.1 binary
release archive. The reviewed local archive had this SHA-256 hash:

`AD038963D6413055765128B0B931F6E765147C9916DBA79E65D872B261F9AF10`

Bundled files:

- `interception.dll`: unmodified x64/AMD64 API library, version 1.0.1,
  SHA-256 `AB88164C11B1B48488772D4C3BFAA4509D5B0AE9DBC5A691DC4F96F0260443C8`.
- `install-interception.exe`: upstream x86 command-line bootstrapper that
  installs the appropriate filter driver, SHA-256
  `E137863A79DA797F08E7A137280FF2A123809044A888FD75CE9C973198915ABE`.
- `LICENSE-LGPL-3.0.txt`: non-commercial license text included upstream.
- `licenses\Interception API.pdf` and `licenses\Interception.pdf`: upstream
  commercial-license descriptions for review only.

`interception.h`, import libraries, samples, and x86 runtime DLLs are not
bundled because Axonkey calls the native API through managed P/Invoke and ships
only as an x64 application.

The commercial-license PDFs are informational. Bundling them does not grant
commercial distribution rights. Review `THIRD_PARTY_NOTICES.md` before release.

## Known RC003 compatibility blocker

Interception 1.0.1 has confirmed keyboard hot-plug and reconnect failures. On
RC003, a Bluetooth HID reconnect can leave the new keyboard node attached to
the `keyboard.sys` upper filter but absent from every Interception keyboard
slot. The device then remains visible and healthy in Windows while producing no
input, regardless of whether Axonkey is running.

Do not treat this binary as a production-safe RC003 dependency. See
[`docs/INTERCEPTION_HOTPLUG_INCIDENT.md`](../../docs/INTERCEPTION_HOTPLUG_INCIDENT.md)
for local evidence, upstream issue links, recovery steps, and replacement
requirements.
