# Provenance and local changes

Upstream: https://github.com/hygorostrowskij/interception-driver-fix

Pinned tag: `v0.5.2`; commit: `e1a7720863f514d51caf06b020da5c0d2e345c41`.
This directory starts from that source/build tree; unused installer artwork is
excluded (the application builds no icon or installer from upstream). See `LICENSE` (BSD-3-Clause).
Upstream permits source/binary redistribution subject to retaining copyright,
conditions, disclaimer, and the no-endorsement condition.

The upstream release installer was inspected as data, not run. Its published
SHA-256 is `a93d808106082ccea5abbb39a322ec95f8e3352f31c8e2fcd0117157340d2238`.
It is **not** bundled or invoked. Axonkey builds a locally adapted service.

Local adaptations (compare these files directly against the pinned Git commit):

- `src/core.hpp`: remove the device-DACL writer entirely; reject `lockdown=yes`;
  initialize link handles and only close successfully created handles. Keep the
  upstream KeyboardClass/PointerClass linking algorithm.
- `src/constants.hpp`: isolate service/config names as `AxonkeyInterceptionFix`
  and `Axonkey Interception Fix`.
- `src/main.cpp`: disallow upstream install/uninstall subcommands and direct
  console execution; only Windows SCM may run the fix. Axonkey manages the
  quoted service path and does not immediately start it during installation.
- `src/utils.hpp`: explicitly include standard-library headers used by helpers.
- `src/cli.hpp`: require the INI file, which Axonkey writes with `lockdown=no`.
- `Axonkey.CMakeLists.txt`: build only the static x64 MSVC service, without the
  upstream Inno installer/artwork. The original CMake/installer files remain
  for audit; do not use them for Axonkey builds.
- `vcpkg.json`: pin baseline and build-tool revision to
  `2750401336fb7c95f6619657a46a7e798661341c`. Dependencies use this baseline's
  source hashes, not rolling runtime downloads.

`axonkey-source-sha256.json` pins the adapted source files. Deliberate source
updates require reviewing the diff and regenerating this inventory. The build
script verifies it before invoking CMake and generates a separate SHA-256
manifest for the resulting exe and licenses. Different compiler/tool versions
may produce different exe hashes; no reproducible-build claim is made.

Dependency licenses: CLI11 uses BSD-3-Clause; fmt, spdlog and phnt use MIT;
Boost Algorithm uses Boost Software License 1.0; bundled sr headers carry MIT
notices in each file. The build copies **all** vcpkg target `share/*/copyright`
files (including transitive dependencies), the BSD notice, and the sr MIT
header into the application and installed payload. Missing required notices
fail the build. This does not change the separate Interception 1.0.1 driver
licensing restrictions documented in `vendor/interception/SOURCE.md`.

Important: upstream master after this tag changed `lockdown=no` to write a
standard DACL. That behavior is deliberately not imported. Deleting the service
does not undo existing permanent object links or legacy DACL changes; verify
rollback with a Windows reboot.
