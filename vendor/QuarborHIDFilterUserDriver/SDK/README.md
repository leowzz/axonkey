# Axonkey 使用的协议文件

此目录仅保留 Quarbor HID v3 的原始 `proto/hid_user.proto`。
Axonkey 在构建时使用 `protox` 和 `prost-build` 生成 Rust 类型，运行时用
`prost` 和 Tokio 直接读写驱动命名管道（InjectKey / ResetInput / Result），不依赖上游 C++ SDK 或 nanopb。

更新驱动包时同步核对该 schema。驱动协议参考 [PROTOCOL.md](../Docs/PROTOCOL.md)，
Axonkey 的调用与验证方式见 [接入说明](../../../docs/quarbor-v3-read.md)。
