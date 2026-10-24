# Quarbor Universal Keyboard Driver 接入说明

Axonkey 的 Windows 输入后端使用仓库中
[`keyboard.proto`](../vendor/QuarborUniversalKeyboardDriverInstaller/SDK/keyboard.proto)
生成的 Rust 类型，通过 Tokio 连接 Universal 驱动的双向命名管道。完整的安装器参数和协议定义以随驱动发布的两份手册为准：

- [安装器用户手册](../vendor/QuarborUniversalKeyboardDriverInstaller/SDK/INSTALL_USER_MANUAL.md)
- [驱动用户手册](../vendor/QuarborUniversalKeyboardDriverInstaller/SDK/DRIVER_USER_MANUAL.md)

## 连接与握手

RC003 的 `BTHLEDEVICE` 父设备实例有独立管道：

```text
\\.\pipe\Quarbor.UniversalKeyboard.v1.<16 位大写十六进制哈希>
```

哈希输入是设备实例 ID 的 ASCII 大小写归一化结果，按 UTF-16LE 字节执行 FNV-1a。客户端使用 `GENERIC_READ | FILE_WRITE_DATA`、独占共享模式和重叠 I/O 打开管道。

驱动先发送 `ServerMessage.hello`，客户端验证协议版本 2 和载荷上限，再发送严格递增请求 ID 的 `query_basic_info`。只有收到并核对 `driver_name`、`device_instance_id` 和能力字段后，客户端才开始处理 `physical_report` 并发送输入命令。

帧由 4 字节小端载荷长度和一条 protobuf 消息组成；载荷上限由 Hello 宣布，当前最大值为 66048。服务端消息可以混合主动物理报告和请求回执，客户端必须持续读取，不能把一次读取当作一条完整消息。

## 输入与输出

设备原始报告使用 `physical_report.data`，保留 Report ID 和设备自己的字节布局。BTHLEDEVICE 源返回的是被动厂商采集描述符，不能当作键盘描述符交给 `HidP_GetUsages`；Axonkey 按 RC003 的 Report ID 加小端 16 位 usage 槽直接解码，再将 13 个 Usage 转成按键边沿。驱动来源的遥控器动作通过 Universal 的 `keysend` / `mouse_move` 回写；Windows 鼠标服务来源的映射动作通过 `SendInput`，退出或断开前发送 `reset_input`。

`keysend` 的值是 HID Usage，不是 Windows 虚拟键或扫描码。驱动来源的标准键盘和 Consumer 媒体控制通过驱动输出，支持的左键、右键、中键和移动／滚轮也通过 `keysend` / `mouse_move` 输出；驱动来源不会回退到 `SendInput`。鼠标服务来源的键盘、鼠标和滚轮动作使用 Windows `SendInput`，因此鼠标用户无需安装该驱动。驱动鼠标集合没有 XBUTTON，遥控器来源的后键／前键会返回不支持；鼠标服务来源仍可使用 Windows XBUTTON。协议没有 Unicode 文本命令，`Paste` 继续使用文本注入接口。每个驱动命令都等待 `input_result`，非零 NTSTATUS 会使当前连接失效并释放已观察的按键状态。

## 构建与排查

`src-tauri/build.rs` 从 SDK 的 `keyboard.proto` 生成 `quarbor.keyboard.v1` Rust 类型；运行时不联编 C++ SDK。真机验收需要将 Universal 驱动安装到 RC003 的 `BTHLEDEVICE` 父设备，并确保其他测试程序没有占用设备管道。日志应出现 `Quarbor Universal capture ready`，随后检查语音键到右 Alt、Shift+A、持续按住、松开、蓝牙重连和睡眠恢复。

若管道找不到，先用安装器 `--list` 确认实例 ID、`present` 和 `bound`；若连接后立即断开，检查设备实例核对、Hello/BasicInfo 顺序、帧长度和请求 ID 是否严格递增。原始报告缓存和输入交付状态的字段解释见 [驱动用户手册](../vendor/QuarborUniversalKeyboardDriverInstaller/SDK/DRIVER_USER_MANUAL.md)。
