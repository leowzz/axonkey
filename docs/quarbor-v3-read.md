# Quarbor v3 HID 读取接入

Windows 遥控器服务通过只读管道读取物理 HID 报告，更新日志及按键按下/松开状态。
驱动连接不发送握手、逐包回复或输入注入命令。系统鼠标映射仍使用其独立实现。
驱动 v3 本身会拦截原设备输入；只读客户端不会将原始按键重新交给 Windows。

已接回遥控器“光标移动”映射：使用 `remote_cursor.rs` 处理单击、双击、长按，
再通过现有 Windows `SendInput` 移动光标，不经过驱动写入。
仅配置一个单击光标动作时，按下立即移动，按住 400ms 后每 80ms 重复；
配置双击时单击等待 350ms，长按阈值为 600ms，长按触发后 350ms 开始每 100ms 重复。
动作序列中的延时不阻塞 HID 采集。关闭映射、修改配置、断线、丢帧或解析失败会取消待执行移动。
键盘替换、键盘输出及其他遥控器动作尚未接回。

## 调用分层

1. `src-tauri/src/input_service/windows.rs` 发现 RC003 键盘设备实例，管理采集、重连和状态。
2. `windows_quarbor.rs` 的 `Reader::connect(instance_id)` 计算 v3 管道名称。
   `poll()` 返回 `Hello`、`Capabilities`、`Report` 或 `Status`，暂无完整消息时返回 `None`。
3. Tokio 以只读权限打开命名管道；一个共享 IO reactor 服务所有连接，采集线程使用非阻塞
   `poll()`。Rust 处理 4 字节小端长度前缀、最多 8192 字节的帧、1 秒半帧超时及连接关闭。
4. `prost` 解码 Protobuf，应用层校验字段范围、消息顺序和设备实例。
   `build.rs` 使用纯 Rust 的 `protox` + `prost-build` 从 SDK 的原始
   `proto/hid_user.proto` 生成 Rust 类型，不需要 protoc。SDK 目录仅保留协议文件和使用说明，
   字段范围限制由 Rust 显式校验。
5. `windows_hid.rs` 通过 `windows` crate 直接调用系统的设备枚举、描述符和 HID 解析 API。
   设备句柄只请求元数据访问权限，不读取设备输入、不发送 HID 输出。

Reader 由采集线程持有，管道 IO 由共享的 Tokio reactor 驱动。
连接顺序必须为 `Hello → Capabilities → Report/Status`；Hello 的实例 ID 与目标设备忽略大小写匹配。
连接错误会关闭旧 Reader 并每隔至少 250 毫秒重试；设备实例变化会重新发现、连接。

原始报告完整保留 Report ID，包括无编号报告的零值 ID 槽位。
键盘状态通过实际设备描述符和 `HidP_GetUsages` 解析，不假定固定长度或 16 位按键数组。
描述符不可用或解析失败时，仍交付完整原始字节；不会猜测按键状态。
断线、设备移除、下层读取错误或丢帧时清理已观察到的按下状态，避免界面一直显示按住。

## 应用事件与状态

原始报告通过 Tauri 事件 `axonkey-raw-hid` 提供：

```ts
type RawHidEvent = {
  instanceId: string
  reportSequence: string
  timestampFiletime: string
  dropped: string
  ntstatus: number
  bytes: number[]
}
```

三个 64 位字段使用十进制字符串，避免 JavaScript 数字精度丢失。
`timestampFiletime` 是从 1601 年起的 UTC 100ns 计数；`reportSequence` 是物理报告序号。
`bytes` 完整保留最多 4096 字节。日志记录序号、时间戳、丢帧计数、总长度及前 32 字节 HEX。
现有 `axonkey-remote-key` 事件继续提供已识别 RC003 按钮的状态。

`InputServiceStatus.capture_active` 在通过 Hello/Capabilities 校验后为真，断线时为假；
`error` 提供连接、协议及下层读取错误。仅枚举到蓝牙设备或键盘实例不代表采集已经成功。

## 验证

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib input_service
cargo build --manifest-path src-tauri/Cargo.toml
```

命名管道集成测试使用实际 Rust 客户端和独立编码的 Protobuf 测试消息，覆盖分片/粘包、
原始按下/释放字节、4096 字节报告、消息方向/字段/顺序错误、半帧超时、空闲连接及取消读取。
测试服务端检查客户端发送字节数为零。它们不会安装驱动或向 Windows 发送按键。

真机验收需要将配套 v3 驱动挂载到 RC003 键盘实例，并确保其他测试程序没有占用设备管道。
应观察 `Quarbor v3 capture ready` 和 `Quarbor HID` 日志，再检查按下、持续按住、松开、蓝牙重连和睡眠恢复。
