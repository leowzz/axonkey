# Quarbor v3 HID 读写接入

Windows 遥控器服务通过双工管道读取物理 HID 报告，并使用 `SendKey` 对应的
`InjectKey` 命令执行设备支持的标准键盘输出；非标及设备不支持的按键使用 Windows 虚拟输入。通信、编解码和调度均使用 Rust，不联编 C++ 或 nanopb。
驱动拦截原设备输入，再将语义命令编码成真实 HID 报告交给 Windows。

`remote_actions.rs` 统一处理单击、双击、长按、替换和动作序列中的延时：

- 替换：物理按下立即 `KEY_DOWN`，物理松开立即 `KEY_UP`，忽略单击/双击/长按配置。
- 仅配置一个单击键盘动作时，按键或组合键保持到物理松开。驱动按键由 Windows 负责按住重复；虚拟音量键及普通键按住 400ms 后每 80ms 重复，播放／暂停等媒体键和修饰键不自动重复。
- 组合键按配置顺序按下、逆序松开；多个按钮共用修饰键时，最后一个使用者释放后才松键。
- 配置双击时，单击等待 350ms；长按阈值为 600ms，触发后 350ms 开始每 100ms 重复动作。
- 关闭映射或该按钮没有启用的动作时，通过 `SendKey` 转发该按钮原始的键盘 usage。
- 仅配置双击／长按、单击没有启用的动作时，普通单击仍输出原键；显式配置“禁用按键”时不输出。
- 修改配置、丢帧、读取错误或解析失败会释放输出并取消排队动作；断线和退出释放虚拟按键，并通过关闭
  管道触发驱动的中性报告收尾，不在重连后重播旧动作。

各动作统一进入调度队列，按序执行，延时使用到期时间而非线程休眠。仅配置一个单击光标或滚轮动作时，按下立即执行，
按住 400ms 后每 80ms 重复，松开停止；配置双击、长按或多动作序列时按相应手势执行。

| 动作 | Windows 执行方式 |
| --- | --- |
| 设备支持的标准按键、组合键、替换 | 驱动 `SendKey`，组合键逆序松开 |
| 播放／暂停、上下曲、停止、音量、静音 | `SendInput` 虚拟键，均不发送驱动命令 |
| 设备不支持的按键 | 转为对应 Windows 虚拟键，通过 `SendInput` 执行 |
| 光标移动、鼠标点击、四向滚轮 | `SendInput` 鼠标事件 |
| 粘贴文本 | `SendInput` UTF-16 Unicode 事件，支持中文及代理对字符 |
| 打开应用、打开网站 | 校验目标后调用系统启动接口，网站仅允许 HTTP(S) |
| 延时 | 推迟序列后续动作，可在配置变更或输入异常时取消 |
| 禁用按键 | 不产生输出 |

系统鼠标映射仍使用其独立实现，其中键盘动作仍走原有 `SendInput` 路径，不依赖 RC003 在线。

## 键盘命令与响应

连接通过 `Hello/Capabilities` 校验后先发送 `ResetInput`。只有能力 flags bit 1
开启时才允许 `send_key(usage_page, usage, down)`，Report ID 省略，由驱动按描述符匹配。
键名转换使用 USB HID usage；例如右 Alt 为 `(0x07, 0xE6)`，Shift+A 顺序为：

```text
SendKey(0x07, 0xE1, KEY_DOWN)
SendKey(0x07, 0x04, KEY_DOWN)
SendKey(0x07, 0x04, KEY_UP)
SendKey(0x07, 0xE1, KEY_UP)
```

每条命令分配非零、严格递增的 `request_id`；最多保留 64 条待确认命令。
写入使用非阻塞队列，保留半帧偏移；排队/响应等待超过 1 秒、队列满、写入失败、
响应编号不匹配或驱动返回非零 NTSTATUS 时关闭连接，由驱动释放输出。
错误日志包含请求编号、usage/action 和 NTSTATUS。普通物理报告、状态和命令结果可以交错；
`Result.request_id` 不参与物理 `report_sequence` 的丢帧判断。

`Result` 成功只证明驱动接受命令，不代表 Windows 已交付输入。目标 usage 必须由设备的
真实描述符支持。应用在连接时读取输入 Button Caps，按驱动规则检查 usage 范围、唯一的
Report ID／Link Collection 和 Capabilities 中的 Report ID 位图；未声明或匹配有歧义的按键提前转为虚拟输入。
Consumer 页媒体键及 Keyboard 页 `0x7F–0x81` 音量／静音始终使用虚拟输入。
若组合键包含虚拟按键，整组使用虚拟输入；与其共享按键的其他组合也统一分流，保证顺序及共享按键计数正确。
按下时记录实际后端，松开时使用同一后端。描述符读取失败时采用虚拟输入；无法转换为 Windows 虚拟键的 usage 会记录错误。

## 调用分层

1. `src-tauri/src/input_service/windows.rs` 发现 RC003 键盘设备实例，管理采集、重连和状态。
2. `windows_quarbor.rs` 的 `Client::connect(instance_id)` 计算 v3 管道名称。
   `poll()` 返回 `Hello`、`Capabilities`、`Report`、`Status` 或 `CommandAccepted`，暂无完整消息时返回 `None`。
3. 使用 Windows `OpenOptionsExt` 以 `GENERIC_READ | FILE_WRITE_DATA` 打开异步管道，
   再将句柄交给 Tokio。不能用 Tokio `.write(true)` 所申请的 `GENERIC_WRITE`：其中包含
   驱动未授予客户端的 `FILE_CREATE_PIPE_INSTANCE`，普通用户会得到“拒绝访问”。
   保留 `SECURITY_IDENTIFICATION`；一个共享 IO reactor 服务所有连接，采集线程使用非阻塞
   `poll()`。Rust 处理 4 字节小端长度前缀、最多 8192 字节的帧、1 秒半帧超时及连接关闭。
4. `prost` 解码 Protobuf，应用层校验字段范围、消息顺序和设备实例。
   `build.rs` 使用纯 Rust 的 `protox` + `prost-build` 从 SDK 的原始
   `proto/hid_user.proto` 生成 Rust 类型，不需要 protoc。SDK 目录仅保留协议文件和使用说明，
   字段范围限制由 Rust 显式校验。
5. `windows_hid.rs` 通过 `windows` crate 直接调用系统的设备枚举、描述符和 HID 解析 API。
   设备句柄只请求元数据访问权限，不读取设备输入、不发送 HID 输出。

Client 由采集线程持有，管道 IO 由共享的 Tokio reactor 驱动。
连接顺序必须为 `Hello → Capabilities → Report/Status/Result`；Hello 的实例 ID 与目标设备忽略大小写匹配。
连接错误会关闭旧 Client 并每隔至少 250 毫秒重试；设备实例变化会重新发现、连接。

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
读取测试确认空闲客户端不发送多余数据；写入测试使用独立线格式校验 ResetInput、
Shift+A、右 Alt、响应交错、错误编号、驱动拒绝、队列上限、超时和断线。
测试管道只授予读取和写入数据权限，并显式拒绝创建管道实例权限；回归测试确认旧的
`GENERIC_WRITE` 连接被拒绝，而使用 SDK 权限的客户端可以双向通信。
服务链路测试验证 HID 状态经过映射确实到达管道，丢帧释放按键，且不调用键盘 SendInput。
这些测试不会安装驱动或向 Windows 发送按键。

真机验收需要将配套 v3 驱动挂载到 RC003 键盘实例，并确保其他测试程序没有占用设备管道。
应观察 `Quarbor v3 capture ready` 和 `Quarbor HID` 日志，再检查“语音键 → 右 Alt”、Shift+A、持续按住、松开、修改配置、蓝牙重连和睡眠恢复。
