# Quarbor HID user-filter SDK v3

Windows x64, C++17, ordinary Win32; no WDK, protoc, Python or administrator
rights required to build/use this C++ client. Runtime and generated code are
included. Wire format: `proto/hid_user.proto`. Nanopb license: `nanopb/LICENSE.txt`.

Add this directory with CMake `add_subdirectory(...)` and link
`quarbor_hid_user_client`, or compile `src/*.cpp`, `generated/hid_user.pb.c`,
`nanopb/pb_common.c`, `nanopb/pb_encode.c`, `nanopb/pb_decode.c`. Include directories:
`include`, `generated`, `nanopb`. Define UNICODE, _UNICODE, NOMINMAX,
WIN32_LEAN_AND_MEAN and _WIN32_WINNT=0x0A00. With MSVC use /utf-8 (the CMake
target sets this for consumers too). Do not enable PB_ENABLE_MALLOC.

`ReportClient::Connect(path, true)` enables writing. Supply strictly increasing,
nonzero request IDs to SendKey/SendReport/ResetInput/QueryInputDiagnostics.
Pump returns typed in-process Packet DTOs: instanceId, capabilities, diagnostics,
key, and raw payload. Header.requestId correlates responses; reportSequence is
the independent physical counter. DTO layout/sizeof is not a wire contract.
Packet.readDetailsFields is the diagnostic optional-field mask;
Packet.HasReadDetails() tests whether all four READ details are present.
Use the matching 0.4.0 driver package.

Other languages can generate their normal bindings from `proto/hid_user.proto`;
`generated/hid_user_pb2.py` is provided for Python. Each pipe frame has a 4-byte
little-endian length (1..8192) followed by a ClientMessage or ServerMessage.
HID report bytes remain limited to 4096. Ignore unknown ordinary fields;
reject missing/unknown message bodies. Never execute commands while decoding.
