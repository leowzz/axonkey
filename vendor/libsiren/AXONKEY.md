# Bundled libsiren

Upstream: https://github.com/kakaroto/libsiren

Revision: c7724c03d4a6daf4d6dff9e917c14ce5071dce66

The original AUTHORS, README, COPYING and source copyright/license headers are
preserved. COPYING contains LGPL 2.1; source headers permit GNU Library GPL
version 2 or later. This vendored code is not covered by any more permissive
license of the surrounding application.

Local changes:

- Check decoder allocation failure.
- Bound the fixed 320-bit input reader and reject truncated envelopes.
- Validate decoded power-table indices and categorization limits before lookup.
- Reject invalid categories / exhausted envelope bit budgets in the decoder.
- Read big-endian input words from bytes without signed shifts or alignment assumptions.
- Use unsigned arithmetic for the noise generator's wraparound addition.

Rust serializes all calls using a global mutex because upstream has global DSP
and bit-reader state. Decoder ownership is RAII, frame sizes are fixed, and
output is normalized from little endian. The encoder is included for synthetic
test vectors; application input uses only the decoder.

`src-tauri/build.rs` compiles the C sources with `cc` using the target compiler
(MSVC on Windows, Clang on macOS), without FFmpeg or a separately installed
codec runtime. macOS must still be built and tested on a Mac; the current
Windows validation does not establish macOS HID transport support.

When distributing statically linked binaries, preserve the applicable LGPL
notices and provide the source/relinking materials required by the license.
