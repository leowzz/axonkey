# RC003 按键码诊断 Demo

该工具只保留 Frida 实验模式，用于观察 RC003 的原始 HID 报告。Axonkey 主程序的正式
Windows 输入链路使用 Quarbor HID 过滤驱动和命名管道，不依赖本诊断工具。

## 运行

需要 Windows x64 和 64 位 Python 3.10+。脚本会编译 Demo，并在首次运行时下载并校验
固定版本的 Frida Gadget，然后请求管理员权限打开采集窗口。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\keycode-demo.ps1 -Frida
```

可以使用 `-PythonPath` 指定 Python；使用 `-BuildOnly` 只编译和准备依赖，使用 `-SelfTest`
运行 WinForms、HID 解析和 Gadget 生命周期自检：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\keycode-demo.ps1 -Frida -BuildOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\keycode-demo.ps1 -Frida -SelfTest
```

Frida 模式从 RC003 所在的 `WUDFHost.exe` 读取实验报告，能够观察返回 `0x00F1`、音量加
`0x0080`、音量减 `0x0081` 等 HID usage。报告会写入
`%LOCALAPPDATA%\Axonkey\diagnostics\keycodes`，并标记设备来源是否已验证。该工具只做
诊断和记录，不做按键映射，也不安装或卸载驱动。

实现和实验边界见 [RC003 诊断结论](../../docs/WINDOWS_RC003_EXTRA_KEYS.md)。来源和许可见
[SOURCE.md](rc003_hid/SOURCE.md)。
