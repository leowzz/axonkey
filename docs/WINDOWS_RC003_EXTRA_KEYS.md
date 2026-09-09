# RC003 返回、音量加减在 Windows 中的诊断结论

2026-09-09 的实体按键测试中，用户确认普通按键可识别，而返回、音量加、音量减无记录。
目前不应把这三个按键的支持理解为在 Interception 的扫描码表中补三个常量。

同日 23:57 的 Frida Demo 已在本机捕获到三个 usage 的原始报告及按下/松开：
返回 `0x00F1`、音量加 `0x0080`、音量减 `0x0081`。采集入口位于 WUDFHost 内部，
报告来源目前标为 `UMDF_PROXY_UNVERIFIED`；自动关联物理设备仍未完成。

## 已验证的事实

- Demo 的 Windows Raw Input 通道记录过 RC003 的确认键（`scan=0x1C`）、主页键
  （`E0 47`）、右方向键（`E0 4D`）、下方向键（`E0 50`），设备路径匹配 RC003。
- 项目的 [macOS HID 后端](../src-tauri/src/input_service/macos.rs) 已有三个实体键的
  原始 usage 映射：返回 `0xF1`、音量加 `0x80`、音量减 `0x81`。新 Frida 采集与之吻合，
  这些值是 HID usage，不能直接作为 Windows `scan` 或 `vk` 使用。
- 本机通过 SetupAPI 和 `HidD_GetPreparsedData` 读取到 RC003 的 HID 元数据：顶层集合为
  `UsagePage=0x01, Usage=0x06`（Keyboard）；Report ID 1 的按钮 usage page 为 `0x07`，
  范围 `0x00–0xFE`。另有 Report ID 6、7、8，使用厂商自定义页 `0xFF00`。
  因此这三个 usage 都落在其键盘报告声明的范围内。
- 使用仅收集返回字节的回调，直接调用本机 Windows
  `HidP_TranslateUsagesToI8042ScanCodes`，得到下表。测试没有注入按键、安装驱动或修改设备。

| 按键 | 原始 usage page | 原始 usage | Windows 转换状态 | 生成的扫描码字节 |
| --- | --- | --- | --- | --- |
| 确认（对照） | `0x07` | `0x28` | `0x00110000` 成功 | `1C` |
| 右方向（对照） | `0x07` | `0x4F` | `0x00110000` 成功 | `E0 4D` |
| 返回 | `0x07` | `0xF1` | `0xC0110009` 无有效转换 | 无 |
| 音量加 | `0x07` | `0x80` | `0xC0110009` 无有效转换 | 无 |
| 音量减 | `0x07` | `0x81` | `0xC0110009` 无有效转换 | 无 |

Microsoft 的 [Windows 键盘输入转换表](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-keyboard-input#scan-codes)
列出的标准音量输入是 Consumer 页 `0x0C` 的 `0xE9 / 0xEA`，与上述 Keyboard 页的
`0x80 / 0x81` 不同。Windows
[转换函数说明](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/hidpi/nf-hidpi-hidp_translateusagestoi8042scancodes)
也明确区分成功转换和无法生成有效扫描码。

## 能得出的结论及边界

转换测试已直接验证：上述三个 Keyboard usage 在本机不能通过标准转换函数生成扫描码。
结合项目已有 HID 映射和实体按键表现，最符合证据的解释是这三个按键在 Windows 的 HID
到键盘扫描码转换阶段没有产生普通键盘事件。因此，在 Raw Input、键盘钩子或现有扫描码
映射表里增加监听条件，不足以恢复这些原始 usage。

Frida 读取的是 Windows 用户态驱动宿主的 I/O 缓冲区，不是蓝牙空口抓包。
新增的 Interception 通道没有记录到真实事件，其 `filter_readback` 为零，不能
将它的零事件单独当成驱动层的有效阴性对照，更不能据此断言发生了设备重连故障。

原始 HID 读取探测还得到：

- 元数据句柄可以打开，能够读取描述符解析结果。
- 对匹配 RC003 的 HID 接口申请 `GENERIC_READ` 返回 Win32 错误 `5`（拒绝访问）。
- 通过元数据句柄调用 `HidD_GetInputReport` 返回错误 `1`（不支持该请求）。

这与 Windows 对
[键盘顶层集合采用独占访问](https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/top-level-collections-opened-by-windows-for-system-use)
的设计一致。该设备没有向本次 Raw Input 枚举暴露独立的 Consumer Control 集合供这三个键采集。

## 后续兼容方向

`codex/rc003-frida-hid-tap` 分支增加了独立 Demo 的 `-Frida` 模式。参考
[windows-remote-mic-app](https://github.com/ZSTDJan/windows-remote-mic-app/tree/ca1d4946a4336ba517e4e2c633f21077ceae82d9)
在 WUDFHost 的 `NtDeviceIoControlFile` 返回时读取 IOCTL `0x80018483` 的报告。
这提供了无需另写内核驱动的实验入口，不能再将自研驱动视为唯一方案。
本机多个蓝牙 HID 设备共享同一个 HostPid，实际 I/O 句柄又是 `UMDFCtrlDev` 代理，
不能通过它直接匹配 RC003 的 HID 设备对象。Demo 会显示原始代理报告，并明确标为
设备来源未验证；还不能将它作为生产映射的设备身份依据。使用和验证见
[Demo 说明](../tools/keycode-demo/README.md#frida-hid-实验模式)。

### 本机 Frida 实测（2026-09-09 23:57）

运行构建：`4f0966f6cb8e`。日志文件：
`%LOCALAPPDATA%\Axonkey\diagnostics\keycodes\20260909-235748-437-16576.log`。

| 按键 | 按下报告（真实采集） | 按下 / 松开时间 |
| --- | --- | --- |
| 返回 | `01 00 00 F1 00 00 00 00 00` | `23:57:56.950` / `23:57:57.143` |
| 音量加 | `01 00 00 80 00 00 00 00 00` | `23:57:58.067` / `23:57:58.266` |
| 音量减 | `01 00 00 81 00 00 00 00 00` | `23:57:58.841` / `23:57:58.979` |

三次松开均对应 `01 00 00 00 00 00 00 00 00`。同一个 UMDF 代理通道还记录到后续
重复的音量加和返回按压。它们经过 `FRIDA_HID` 与 `FRIDA_KEY` 记录，未经扫描码转换。
Demo 没有执行重映射；这些记录验证了本机采集通道和 usage 解析，不代表物理设备身份
已由程序独立验证，也不代表正式应用已支持这三个键。

之前的两处实验问题已修正：直接 HID 设备对象校验不能匹配 UMDF 代理；旧 Gadget
可能重连并抢占新版本接收端。现在代理报告明确标为来源未验证，各版本使用独立端口、
DLL 名称和脚本标识，避免旧代码冒充新采集通道。

需要在 HID usage 转成键盘扫描码之前取得报告，再把这三个 usage 转成支持的输出。
可评估只绑定 RC003 的 HID 过滤驱动，或独立蓝牙/HID 桥接设备；这属于输入链路的改造。
蓝牙 GATT 是否允许应用直接订阅系统接管的 HID 报告，需要另行验证，不能假定能够通过
普通 GATT 订阅替代键盘驱动。当前没有安装新的过滤驱动，也没有修改设备绑定。

如果先在 macOS 做兼容，现有后端已经能够按原始 usage 区分这三个实体键。

## 复现转换测试

在仓库根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\check-rc003-hid-usages.ps1
```

该脚本检查本机 Windows 转换函数对已知 usage 的处理，不要求遥控器在线，也不记录键盘输入。
