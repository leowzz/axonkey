# Windows 输入

Axonkey 在 Windows 11 x64 上使用 QuarborHIDFilterUserDriver 处理 RC003 按键映射。首次使用时，引导会把驱动包的私有模型显式绑定到当前 RC003 的枚举 HID 键盘设备；卸载时使用保存的原驱动信息恢复设备，即使设备暂时离线也会保留恢复记录。

## 输入链路

Quarbor UMDF 过滤器只安装到选中的 RC003 设备实例，不注册全局 Keyboard 类过滤器。驱动将原始 HID 报告发送到 `\\.\pipe\Quarbor.HidUserFilter.v1.<16 位实例哈希>`。Rust 后端按设备实例计算管道名，校验 48 字节协议头，处理 Hello/Report 帧，并把 RC003 的 HID usage 边沿转换为内部按键事件。映射状态机继续处理单击、双击、长按和行为序列，输出通过 Windows `SendInput` 发送。

普通键盘不会进入 RC003 映射流程。管道客户端使用 `SECURITY_IDENTIFICATION`，只读取当前设备对应的本机管道；设备重新枚举后，客户端会按新的实例 ID 重连。

Windows 支持 13 个可配置按键。RC003 已知 HID usage 包括确认 `0x28`、TV `0x35`、语音 `0x3E`、主页 `0x4A`、方向 `0x4F/0x50/0x51/0x52`、菜单 `0x65`、电源 `0x66`、返回 `0xF1` 和音量 `0x80/0x81`。驱动报告保留 Report ID 和原始字节，客户端只对已知 RC003 usage 生成按键边沿。

返回键和音量 `+ / -` 与其他 RC003 按键一样，由 Quarbor HID 报告直接解析，不需要单独开启功能或额外授权。映射页对这三个按键使用与其他按键相同的行为编辑器。

## 安装与语音

Tauri 直接运行随包提供的 `QuarborHIDFilterUserDriverInstaller.exe`：`--list` 以普通权限查询设备，安装使用 `--install <instanceId>`，由安装器自行请求 UAC；卸载使用 `--uninstall-all`，因此设备离线时也能清理恢复记录和全部 Quarbor 绑定。应用安装时只选择 RC003 HID 键盘，安装要求在线。包暂存、绑定和恢复记录都由安装器管理。状态查询使用 JSON 的 `bound` / `recoveryActive` 字段，已恢复的历史记录不会误报为安装；操作按退出码和 `rebootRequired` 提示重启，取消 UAC 单独显示。接口见 [安装器 CLI 文档](../vendor/QuarborHIDFilterUserDriver/Docs/quarbor-hid-user-installer-cli.md)。

RC003 语音由独立 Bluetooth GATT 链路处理。需要语音时安装 VB-CABLE；Axonkey 解码音频并输出到 `CABLE Input`，录音应用选择 `CABLE Output`。

## 故障排查

若设备已连接但按键没有响应，请查询安装器 `--list`，确认 RC003 的 `present` 和 `bound` 状态，并重新连接 RC003。运行日志和驱动操作日志位于 `%LOCALAPPDATA%\Axonkey\logs`，驱动日志包含安装器命令、退出码及 JSON 输出。
