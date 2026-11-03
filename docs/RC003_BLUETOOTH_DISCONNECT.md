# Windows RC003 周期性蓝牙断连排查

记录日期：2026-11-03。状态：已确认捕获到的断连原因为 BLE 链路层响应超时，具体触发机制与修复仍待验证。以下时间均为北京时间。

[Windows 输入](WINDOWS_INPUT.md) · [常见问题与排障](TROUBLESHOOTING.md)

## 现象与环境

用户持续使用音量加 → `C`、返回 → `X` 映射，间歇出现按下无反应，连续按几次后恢复。用户明确报告的一次失效时间为 **21:42:53**。检查时两项映射均已启用，活动配置正确。

| 项目 | 本次环境 |
| --- | --- |
| 应用 | Axonkey 1.7.13，Windows x86_64 |
| 遥控器 | 小米 RC003，VID `2717` / PID `32B8` |
| 输入后端 | Quarbor Universal |
| 蓝牙适配器 | Realtek Bluetooth Adapter，USB VID `0BDA` / PID `0852` |
| 适配器驱动 | `18.4032.2510.900`，日期 2025-10-11 |

这些结论对应本机本次采样，不能推广为所有 RC003 或 Realtek 适配器都会发生。

## 已确认的证据

### 应用日志与失效时间吻合

`axonkey.log` 记录：

```text
21:42:48 RC003 voice bridge stopped: RC003 voice channel disconnected; wake the remote to reconnect
21:42:54 RC003 voice GATT connected
21:42:54 RC003 voice capabilities ready
```

用户报告的 21:42:53 落在这个断开窗口内。在本次应用会话的一个统计窗口中，共出现 32 次断连；连接持续时间中位数约 46 秒，断开至 GATT 恢复耗时 3～7 秒，中位数约 5 秒。连续按几次后恢复，可能只是重连完成，不能据此认定重复按键解除了卡键。

检查时当天日志未记录输入服务或设备管理的 WARN/ERROR，但 Windows 实现没有逐次记录 HID 按下、松开及映射输出，因此不能用“没有输入错误日志”证明输入链路正常，也不能逐次还原用户漏掉的按键。

### 底层 HCI 跟踪确认原因码

通过 Windows ETW 的 `Microsoft-Windows-BTH-BTHPORT` provider 抓取 HCI 通信，两份跟踪共捕获三次 RC003 断连。通过重连事件中的设备地址核对，该遥控器在采样中的连接句柄为 `0x0010`；句柄只在对应跟踪上下文中有效，不能硬编码为设备身份。

| 时间 | 事件 | 关键数据 |
| --- | --- | --- |
| 21:47:03.899 | 断开 | `05 04 00 10 00 22` |
| 21:48:46.100 | 断开 | `05 04 00 10 00 22` |
| 21:48:50.678 | RC003 重新连接 | LE Enhanced Connection Complete，句柄 `0x0010` |
| 21:48:55.688 | 遥控器请求连接参数更新，主机接受并提交 | L2CAP Connection Parameter Update Request / Response、HCI LE Connection Update |
| 21:48:55.691 | 参数更新完成 | 状态 `0x00`；间隔 12.5 ms，外设延迟 49，监督超时 5,000 ms |
| 21:49:37.306 | 再次断开 | `05 04 00 10 00 22` |
| 21:49:41.841 | RC003 重新连接 | LE Enhanced Connection Complete |

断开事件解码为 HCI Disconnection Complete：状态 `0x00`、句柄 `0x0010`、原因 **`0x22`（LMP/LL Response Timeout）**。本设备使用 BLE，对应链路层过程响应超时。捕获窗口内未见针对 RC003 句柄的主机 HCI Disconnect 命令；跟踪中其他设备的主动断开不能混算到 RC003。

上述完整周期持续约 46.6 秒，参数更新完成后约 41.6 秒断开。蓝牙规范规定链路层过程响应超时为 40 秒，但 **HCI 跟踪不展示全部空口 LL 控制包，不能由这个时间差认定参数更新就是超时的过程**；该参数更新事件本身报告成功。5,000 ms 的连接监督超时与 40 秒的过程响应超时也不是同一参数。

### 系统与代码侧线索

- Windows System 日志中的 BTHUSB Event 5 在 21:29:10、21:34:17、21:38:34、21:39:26 报告“蓝牙驱动程序需要某一大小的 HCI 事件，但是没有收到”。它们出现在部分重连窗口内，但不足以证明是每次断连的原因。
- Realtek 适配器和 RC003 HID 设备的 `MSPower_DeviceEnable.Enable` 均为 `True`。这只是电源管理设置，未证明此次发生了省电断开。
- [Windows 语音实现](../src-tauri/src/devices/xiaomi_remote/voice/windows.rs) 的 `VoiceConnection::run` 检查 `BluetoothLEDevice.ConnectionStatus()`，在读到 `Disconnected` 后返回错误；外层清理连接并等待 2 秒后重试。未发现约 46 秒的应用主动断开计时器。日志中的断开文字来自 Windows 设备状态，并非单纯“没有音频数据”。

## 当前判断与软件修复边界

已确认捕获到的直接断连原因是 BLE 链路层响应超时。优先调查 Realtek 适配器／驱动与 RC003 固件的协议交互，但尚未确定具体哪个过程超时、哪一端存在缺陷，也未完全排除无线环境因素或应用 GATT 操作参与触发。

| 层次 | 可调查或修复的方向 | 当前边界 |
| --- | --- | --- |
| Axonkey 语音连接 | GATT 会话生命周期、连接时机、重连行为 | 若对照实验证明语音会话参与触发，应用层可能解决；当前未证实 |
| 蓝牙驱动／遥控器固件 | 经验证的驱动更新、回退或固件修复 | 若问题在底层协议兼容性，应用层无法保证消除 `0x22` |
| Axonkey 输入恢复 | 检查真实断连是否触发状态释放、重连后映射是否恢复 | 应复用并验证现有释放机制；未收到的物理按键无法可靠补回 |

不要仅凭本次记录直接加入心跳、强制改连接参数或固定周期重连。普通 GATT 保活读写尚无证据能解决此次 LL 响应超时；在因果未确认前，这些改动可能掩盖问题。

## 后续验证（均未执行）

1. **优先隔离语音会话**：在受控诊断中暂时停止 RC003 语音 GATT 连接，保留同一遥控器、蓝牙适配器和按键映射，连续覆盖多个原有断连周期。不能仅把语音键映射清空或停止录音当作关闭 GATT；必须确认连接工作线程确实停止建立语音会话。若当前界面不能独立控制，需要诊断版本支持。
2. **退出应用对照**：保持设备与驱动环境不变，退出 Axonkey 后通过 HCI 跟踪观察连接是否仍周期性断开。退出应用会同时改变多个应用组件，不能单凭结果把责任精确归到语音模块；也不能假定退出后原生 HID 按键必然透传。
3. **适配器／驱动对照**：使用另一款蓝牙适配器，或在确认设备适配与可恢复方案后对照驱动版本。一次只改变一个因素，保持应用、遥控器和使用场景一致。
4. **补充最小诊断**：若要定位每次漏键，记录带时间戳的遥控器输入边沿、映射输出与连接状态；关联设备身份和当次 HCI 句柄，避免把不同遥控器的断开混在一起。现有日志无法回溯补齐这些事件。

每次对照记录运行条件、断连次数、HCI 原因码、恢复耗时以及按键是否正常；仅看到系统显示“已连接”不能作为修复验收。

## 证据留存与规范依据

本次应用日志位于 `%LOCALAPPDATA%\com.axonkey.app\logs\axonkey.log`。两份本机临时跟踪分别为 `%TEMP%\axonkey-bluetooth-diagnosis.etl` 和 `%TEMP%\axonkey-bluetooth-cycle.etl`，各有同名 `.xml` 解码文件；原始文件未纳入仓库，临时目录可能被清理，本页保留了关键事件摘录。

ETW 捕获已停止。此次仅排查和记录，未修改驱动、电源设置或应用连接行为，也未验证任何修复。

- [Bluetooth SIG：Controller Error Codes，0x22](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core_v6.3/out/en/architecture%2C-change-history%2C-and-conventions/controller-error-codes.html)
- [Bluetooth SIG：Link Layer Specification，§5.2 Procedure response timeout](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-54/out/en/low-energy-controller/link-layer-specification.html)
