# Windows 输入

Axonkey 在 Windows 11 x64 上使用 Interception 1.0.1 处理 RC003 按键映射。
首次使用时通过应用引导安装驱动并重启 Windows，之后修改映射无需重启。

## 输入链路

Rust 后端通过 `libloading` 加载随应用提供的 x64 `interception.dll`，按硬件 ID
匹配小米 RC003（`VID_2717&PID_32B8`），只为目标设备设置输入过滤条件。
按键事件经过单击、双击和长按状态机处理，再从同一设备发送映射后的输入。
普通键盘不进入 RC003 映射流程。

Windows 提供 13 个可配置按键。其中返回键和独立音量 `+ / -` 通过可选 Frida
通道读取，其他 10 个按键继续使用 Interception。三个额外键的 usage 分别为
`0xF1`、`0x80`、`0x81`；均进入现有单击、双击、长按和行为序列流程。

## 返回键与音量键授权

1. 开启顶部“启用自定义按键功能”，完成 Interception 驱动设置并连接 RC003。
2. 在首页或映射页打开“返回键与音量键支持”。Windows 会弹出 UAC，选择“是”。
3. 采集组件连接就绪后显示“已启用”，三个按键直接执行已保存的映射，无需测试或校准。

应用主体保持普通权限，只有不带界面的采集辅助进程获得管理员权限。拒绝授权、
组件加载失败和连接超时都会显示原因，并提供重新授权入口。保持开关打开且
自定义按键功能已启用时，下次启动应用会在恢复设置后自动请求一次 UAC 授权。
取消后本次运行不会重复弹窗，界面重建也不会再次请求，可手动重试；导入或修改映射不会再次触发启动授权。
关闭开关、关闭自定义按键
功能或从托盘退出，会停止采集并释放已按下的映射输出，取消尚未触发的手势。
关闭主窗口仍继续托盘运行。

Frida Gadget 17.15.3 已嵌入 Windows 程序，启动时校验并释放至受保护的
`%ProgramData%\Axonkey\extra-keys` 目录。无需安装 Python、Frida 命令行或新的
内核驱动。辅助进程退出后 Hook 解除；DLL 本身由 Windows 回收 WUDFHost 时卸载。

Windows 可让多个蓝牙设备共用 WUDFHost。应用验证 RC003 的宿主和当前设备，
在允许的设备对象内，自动接入首个符合报告格式且包含三个额外 usage 之一的流，
首次按键立即进入映射。普通键和空报告不触发接入，接入后其他报告流不进入映射。
UMDF 代理本身不带可验证的 RC003 VID/PID；如果同一宿主内另一设备先发送相同格式
和 usage，仍可能误匹配，不能据此保证这类设备之间的硬件隔离。句柄关闭、设备对象
或宿主变化后释放旧输出并自动重新接入，无需用户确认。不会持久化代理名或句柄。
保留原行为时，返回发送 Windows 浏览器返回键，音量加减发送系统音量键。
关闭此支持时，Windows 原生路径仍可能丢弃三个 usage。

双击、长按和行为序列产生的模拟短按会保持 50 毫秒后松开，以兼容轮询键盘
状态的软件。只有单击映射时，按键仍跟随遥控器实际按住和松开的时机。

来源、许可证与校验值见 [Frida 来源说明](../vendor/frida/SOURCE.md)，
原始实测依据见 [三个额外按键的诊断结论](./WINDOWS_RC003_EXTRA_KEYS.md)。

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
