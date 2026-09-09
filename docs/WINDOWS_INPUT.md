# Windows 输入

Axonkey 在 Windows 11 x64 上使用 Interception 1.0.1 处理 RC003 按键映射。
首次使用时通过应用引导安装驱动并重启 Windows，之后修改映射无需重启。

## 输入链路

Rust 后端通过 `libloading` 加载随应用提供的 x64 `interception.dll`，按硬件 ID
匹配小米 RC003（`VID_2717&PID_32B8`），只为目标设备设置输入过滤条件。
按键事件经过单击、双击和长按状态机处理，再从同一设备发送映射后的输入。
普通键盘不进入 RC003 映射流程。

Windows 提供 10 个可配置按键：电源、语音、四向、确认、主页、菜单和 TV。
返回键和独立音量 `+ / -` 键不作为映射触发键；应用不主动映射这些键，但这不保证
Windows 能识别其原始 HID usage。已验证的转换限制见 [三个额外按键的诊断结论](./WINDOWS_RC003_EXTRA_KEYS.md)。
可配置按键仍可映射为系统音量增大、减小或静音。

关闭主窗口后，Axonkey 继续常驻系统托盘并处理映射。
关闭“启用自定义按键功能”可恢复原按键行为；从托盘退出应用会释放
Interception context，停止处理自定义映射。

## 安装与语音

Interception 的安装和卸载需要管理员权限及 Windows 重启。
安装脚本在提权前校验随项目提供的安装器和运行库哈希。
卸载输入驱动后，自定义按键映射需要重新安装驱动才能使用。

RC003 语音由独立的 Bluetooth GATT 链路处理。需要语音时安装 VB-CABLE；
Axonkey 解码音频并输出到 `CABLE Input`，录音应用选择 `CABLE Output`。
按键映射不要求安装 VB-CABLE。

详细安装步骤见 [README](../README.md)，双平台实现见
[架构说明](./ARCHITECTURE.md)，驱动来源与校验值见
[Interception 来源说明](../vendor/interception/SOURCE.md)。

## 故障排查

若 RC003 断连后重新连接，Windows 显示设备正常但所有按键都无响应，
可能遇到了 Interception 的设备重新枚举问题。退出 Axonkey 释放的是用户态
context，无法修复已经异常的内核驱动状态。
原因、原始 issue 和恢复步骤见 [Interception 重连问题说明](./INTERCEPTION_HOTPLUG_INCIDENT.md)。

## 返回键与音量键采集 Demo

需要确定返回、音量加、音量减的实际 Windows 按键码时，可以运行独立的
[按键码诊断 Demo](../tools/keycode-demo/README.md)：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\keycode-demo.ps1
```

Demo 同时记录 Interception 原始扫描码、Raw Input、HID 报告、全局键盘事件和窗口媒体命令，
并标注设备来源与实时采集状态。Interception 通道仅过滤 RC003，收到的事件立即原样转发。
从托盘退出 Axonkey 后，按窗口提示分三组采集；日志自动保存在本机，便于后续兼容分析。
