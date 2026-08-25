# Windows 单设备键盘输入替代方案调研

- 调研日期：2026-08-24
- 目标设备：小米 RC003，`VID_2717&PID_32B8`
- 目标平台：普通 Windows 10/11 x64，Secure Boot 保持开启
- 当前阻断：[Interception 热插拔事故](./INTERCEPTION_HOTPLUG_INCIDENT.md)

## 结论

达到 Axonkey 生产门槛的候选路线只有两条：

1. **优先验证 OpenInputBridge 1.00 的 WHQL 包。** 它兼容现有 Interception
   用户态协议，迁移代码量最小；源码也确实使用 KMDF 的每设备 PnP
   `EvtDeviceAdd`/cleanup 生命周期，不再沿用 Interception 固定槽位只分配不释放的实现。
   但上游没有公布 RC003 或等价蓝牙 HID 的循环重连压力结果，Windows 10 也不是其正式
   支持目标；WHQL 二进制虽已发布为付费产品，**是否允许随 Axonkey 再分发尚无公开条款**。
   因此它是首选 PoC，不是可以直接宣称修复的现成依赖。
2. **若 OpenInputBridge 的实机稳定性或商业分发条款不通过，则开发 Axonkey 专用的
   KMDF 设备上层过滤驱动。** 只绑定 RC003 键盘 TLC，默认透传，客户端关闭、崩溃或
   心跳超时立即恢复透传。这条路线能把攻击面和 PnP 状态限定到一个产品，但必须承担
   WDK 开发、HLK/WHQL、安装器、升级/卸载和长期内核兼容维护成本。

另有一条适合快速证伪的实验路线：`kbdaddid` 给输入事件写入设备标识，再由
`WH_KEYBOARD_LL` 只吞 RC003。但其 1.00 上游说明明确承认 Bluetooth 设备可能因初始化时序
拿不到标识，因此不能把它算作已经满足 R1/R3 的生产候选。

Raw Input、普通 `WH_KEYBOARD_LL`/`SendInput`（包括 Kanata `winIOv2`）、Windows
Keyboard Filter、HidHide、PowerToys、KMonad、KeyMagic 等用户态或通用方案均不能同时
做到“知道是 RC003”与“只吞掉 RC003 原事件”。**不存在满足当前硬要求的纯用户态方案。**

## 判定口径

本文使用三种证据标签：

- **已确认**：Microsoft API/驱动文档，或候选项目的源码、README、许可证直接证明。
- **推断**：由已公开接口字段或实现路径推导，尚未在 RC003 实机验证。
- **未知**：上游未公布，必须通过授权确认或实机测试解决。

硬要求如下：

| 编号 | 要求 | 通过条件 |
| --- | --- | --- |
| R1 | 单设备识别 | 能按 RC003 VID/PID、硬件 ID，或稳定的设备实例身份选择输入源 |
| R2 | 独占覆盖 | 映射时原按键不泄漏；普通键盘不受影响 |
| R3 | PnP | 蓝牙休眠、移除、重建、睡眠恢复后不重启系统即可恢复 |
| R4 | 失败透传 | Axonkey 禁用、退出、崩溃或失去响应后，后续 RC003 原输入可用 |
| R5 | 正常安全配置 | Windows 10/11 x64，Secure Boot 和 Memory Integrity 不要求关闭 |
| R6 | 可分发 | 签名与许可证明确允许随 Axonkey 发布、升级和卸载 |

## 决策矩阵

`条件满足` 表示仍有明确前置条件；`否` 表示架构上不满足，不应再投入集成 PoC。

| 方案 | R1 单设备 | R2 只吞目标 | R3 PnP | R4 失败透传 | R5 Secure Boot | 集成量 | 分发/许可证 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **OpenInputBridge 1.00 WHQL** | 是，硬件 ID + 临时槽位 | 是，按槽位设过滤 | 设计满足；RC003 压测未知 | 源码在 file-close 时清理；卡死无 watchdog | WHQL 包声称满足；Win10 正式支持未知 | **低** | 源码 MIT、兼容库 LGPL；WHQL 包付费，再分发权未知 | **优先验证** |
| **Axonkey 专用 KMDF 设备过滤驱动** | 是，INF/运行时双重限定 | 是 | WDF 设计可满足；需自行验证 | 可设计为 fail-open + lease | 完成 HLK/WHQL 后满足 | **高** | 自有代码；若复用微软样例需遵守 MS-PL | **战略后备/长期最可控** |
| Raw Input | 是，`hDevice`/设备路径/VID/PID | **否** | 是，有到达/移除通知 | 是 | 是 | 低 | Windows API | 只适合监控、连接状态和诊断 |
| `WH_KEYBOARD_LL` + `SendInput` / Kanata `winIOv2` | **否** | 能吞事件，但无法判定来源 | 用户态，无设备 PnP 状态 | 退出后恢复 | 是 | 低 | Kanata LGPL-3.0-only | 不满足 |
| **kbdaddid + `WH_KEYBOARD_LL` + `SendInput`** | 条件满足；事件携带 16-bit UniqID | 标识非零时可只吞目标 | **Bluetooth 标识可能为 0**；RC003 未测 | 驱动只打标，用户态 hook 移除后透传 | 付费 WHQL 包仅声明 Win11 24H2 | 中 | 源码 MIT；公开付费包限一台 PC 且禁止转让/销售 | **仅作快速实验** |
| Raw Input + 低层 hook 时间相关联 | 不可靠 | 不可靠 | 不可靠 | 是 | 是 | 中 | 自有代码 | 无文档保证，禁止作为生产方案 |
| Windows 内置 Keyboard Filter (WEKF) | **否** | 按键/组合全局屏蔽 | 系统功能 | 是 | 是 | 低 | 仅特定 Windows 版本/版本 SKU | 不满足 |
| HidHide + Raw Input | 可选设备实例 | **否：不能保证阻断系统键盘路径** | RC003/键盘重连行为未知 | 配置错误风险较大 | 有签名发布 | 中 | MIT | 不适用于键盘 class 输入替换 |
| keymapper（Windows） | 仅装 Interception 后支持 | 仅装 Interception 后支持 | 继承 Interception 缺陷 | 继承后端 | 继承后端 | 中 | GPL-3.0 | 明确被上游判定不安全 |
| KMonad（Windows） | **否** | 全局 hook | 用户态 | 是 | 是 | 中 | MIT | 不满足 |
| KeyMagic 3 / TSF IME | **否** | 处理文本输入，不是物理设备过滤 | 不相关 | 是 | 是 | 高且方向错误 | GPL-2.0 | 不满足 |
| DeviceMapper | 能用 Raw Input 区分 | **否，所谓 block 只丢自身事件** | 有 Raw Input 通知 | 是 | 是 | 中 | MIT | README 宣称与源码不一致，不采用 |
| `xps15kbfix` 等 kbfiltr PoC | 可在驱动中区分 | 是 | 理论可 | 取决于自定义实现 | 无可分发微软签名包 | 高 | MIT/项目各异 | 仅作样例，不是产品依赖 |

## 方案分析

### 1. OpenInputBridge

#### 已确认

OpenInputBridge 是 Interception 用户态 IOCTL 协议的 clean-room KMDF 重实现。
上游状态表称键盘/鼠标过滤、硬件 ID、捕获、写回、安装器和 WHQL 均已完成实机测试；
兼容性测试仍在进行，真实消费应用尚未全部验证。源码为 MIT，嵌入的未修改
Interception 用户态库继续使用 LGPL。见固定提交的
[README](https://github.com/Applet-LLC/OpenInputBridge/blob/a661848ddf4deadc07e6c6df9d374c20df5f4c01/README.md)。

它的 PnP 设计与 Interception 的关键区别可以从源码直接确认：

- 每次设备到达由 KMDF 创建一个过滤 `WDFDEVICE` 并分配空槽；设备对象 cleanup 时释放槽位，
  见 [`kbdfilter.c`](https://github.com/Applet-LLC/OpenInputBridge/blob/a661848ddf4deadc07e6c6df9d374c20df5f4c01/driver/keyboard/kbdfilter.c#L21-L80)
  和 [`slots.c`](https://github.com/Applet-LLC/OpenInputBridge/blob/a661848ddf4deadc07e6c6df9d374c20df5f4c01/driver/common/slots.c#L69-L127)。
- 未被客户端过滤的包立即调用原 `ClassService` 透传；被过滤的包才进入用户态队列，见
  [`OibKbFilterServiceCallback`](https://github.com/Applet-LLC/OpenInputBridge/blob/a661848ddf4deadc07e6c6df9d374c20df5f4c01/driver/keyboard/kbdfilter.c#L157-L197)。
- 过滤状态属于打开的文件句柄；句柄关闭时从槽位链表移除并释放队列。因此进程正常退出或崩溃导致
  Windows 关闭句柄后，后续输入回到透传，见
  [`OibCtlEvtFileClose`](https://github.com/Applet-LLC/OpenInputBridge/blob/a661848ddf4deadc07e6c6df9d374c20df5f4c01/driver/common/ioctl.c#L408-L429)。
- `IOCTL_GET_HARDWARE_ID` 返回 PDO hardware ID；同型号设备的值相同。槽位可以区分本次连接的
  物理 PDO，但槽号按到达顺序临时分配，重连后不保证不变，见
  [`PROTOCOL.md`](https://github.com/Applet-LLC/OpenInputBridge/blob/a661848ddf4deadc07e6c6df9d374c20df5f4c01/docs/PROTOCOL.md#L48-L69)
  和[硬件 ID 说明](https://github.com/Applet-LLC/OpenInputBridge/blob/a661848ddf4deadc07e6c6df9d374c20df5f4c01/docs/PROTOCOL.md#L193-L205)。

2026-08-20 的官方
[1.00 release](https://github.com/Applet-LLC/OpenInputBridge/releases/tag/1.00)
列出 WHQL Subscription（5 美元/季度）和 Pro（一次性 40 美元）版本。仓库 README 也明确：
自编译免费版需要 test-signing，Secure Boot/BitLocker 需要关闭；购买的 WHQL 版不需要这些步骤。

#### 对 Axonkey 的集成影响

**推断：集成量低。** Axonkey 当前在
[`src-tauri/src/input_service/windows.rs`](../src-tauri/src/input_service/windows.rs)
动态加载标准 `interception.dll` 的七个 API，并已经按 hardware ID 扫描槽位、只给匹配槽位设置
过滤。OpenInputBridge 以兼容这些 API 为目标，因此映射/手势状态机可保持不变，主要工作在：

1. 替换驱动安装、检测、卸载和第三方声明；
2. 校验运行中的驱动 identity，避免把旧 Interception 与 OpenInputBridge 混装；
3. 每次 PnP 重连后重新扫描 hardware ID，再启用新槽位过滤；不能缓存旧槽号；
4. 重新审计二进制、catalog、安装器签名和安装/卸载回滚；
5. 更新 UI，不再把 Interception 作为生产依赖。

#### 风险与未知项

- **未知：RC003 高频蓝牙 HID 重建。** 源码具备到达/移除释放逻辑，但上游文档没有 100 次
  重连、约 52 秒 idle 周期、forget/pair 或 Modern Standby 的结果。
- **未知：Windows 10 正式支持。** 安装器检查允许 Windows 10 1903+，但 README 明说正式支持
  目标是 Windows 11+。
- **未知：再分发权。** 公开源码许可证不等于购买者能把 Applet LLC 的 WHQL 二进制和 license
  key 随第三方产品无限再分发。需要书面确认 OEM/redistribution、每用户或每产品授权、离线激活、
  更新和停止订阅后的运行权。
- **已确认：驱动是 keyboard/mouse class 级 UpperFilter。** 即使 Axonkey 只过滤 RC003，驱动仍附着
  到系统全部键盘/鼠标栈；上游还明确指出兼容接口可被普通用户进程用于观察/注入系统输入。这比
  RC003 专用驱动有更大的攻击面。
- **推断：挂死不 fail-open。** 文件句柄只有在关闭时才移除过滤；若 Axonkey 进程卡死但句柄仍开着，
  驱动没有公开的 heartbeat/watchdog，RC003 后续事件可继续被排队而不透传。
- **推断：槽位复用存在客户端竞态。** 目标移除后若另一键盘先占用空槽，而旧客户端过滤仍绑定该槽，
  在客户端重新扫描前可能暂时捕获错误设备。PoC 必须专门覆盖该场景。

**结论：值得立即做签名包 PoC；在授权书和本文验收矩阵通过前，不应进入生产安装器。**

### 2. Windows Raw Input

#### 已确认

Raw Input 的 `RAWINPUTHEADER.hDevice` 可以标识产生某条输入的设备；应用还能枚举设备并读取设备信息。
注册是按 HID top-level collection 的 Usage Page/Usage，而不是按一个 `hDevice` 注册。见 Microsoft
[Raw Input overview](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input)
和 [`RegisterRawInputDevices`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerrawinputdevices)。

`RIDEV_DEVNOTIFY` 可以收到设备到达/移除通知，因此它很适合替代当前 PnP 轮询做连接状态；
`RIDEV_INPUTSINK` 可以后台收取事件。`RIDEV_NOLEGACY` 的文档语义是：不为注册的键盘 TLC
向**该应用**生成 legacy 消息；注册结构没有物理设备句柄字段，也不会阻止其他应用收到正常键盘输入。
见 [`RAWINPUTDEVICE`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)。

#### 结论

Raw Input 满足“看到 RC003”和热插拔通知，但不满足全局、单物理设备抑制。可用于：

- 连接状态和 VID/PID 诊断；
- 只触发无害附加动作、允许原按键同时通过的降级模式；
- 替代方案的自动化测试观测通道。

不能用于 Axonkey 的 `disabled` 或 replacement 行为。

### 3. 低层键盘 hook、SendInput 与 Kanata `winIOv2`

#### 已确认

`WH_KEYBOARD_LL` 回调收到的
[`KBDLLHOOKSTRUCT`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-kbdllhookstruct)
只有 virtual key、scan code、flags、时间和 extra info，**没有设备句柄或硬件身份**。回调返回非零可以
阻止事件继续传递，见 Microsoft
[`LowLevelKeyboardProc`](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)。
这意味着它能吞键，但无法确认来源是 RC003。

[`SendInput`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
可以合成替代按键，但受 UIPI 限制，只能注入到相同或更低 integrity level 的应用；它也不补足来源身份。

Kanata 官方 release 明确区分：`winIOv2` 使用 LLHOOK + SendInput，`wintercept` 使用 Interception，
且警告后者可能让键鼠失效直到重启。见
[Kanata Windows release notes](https://github.com/jtroo/kanata/releases)。Kanata 维护者也明确说明
Windows 默认 LLHOOK 不能区分键盘设备，见
[multiple keyboards discussion](https://github.com/jtroo/kanata/discussions/382)。

#### Raw Input + hook 相关联为什么也不可靠

**推断：** 两条 API 给出的是两个独立事件流，没有共同的事件 ID；hook 数据没有 `hDevice`。
用 scan code + 时间戳猜测来源，在普通键盘与 RC003 同时按键、重复键、修饰键和负载抖动下会误吞普通键盘。
这不是 Windows 文档承诺的关联机制，不能满足 R2。

#### 结论

Kanata `winIOv2` 可以做“所有键盘统一映射”的快速演示，不能作为 Axonkey 后端；
`wintercept` 则完整继承当前故障。Kanata 本体使用 LGPL-3.0-only，但许可证不是这里的主要阻断。

### 4. kbdaddid：给低层 hook 补设备身份

#### 已确认

Applet LLC 的 [`addid`](https://github.com/Applet-LLC/addid) 是一个 keyboard/mouse class
filter。它不捕获输入，而是把由设备标识计算出的 16-bit `UniqID` 写入
`KEYBOARD_INPUT_DATA.ExtraInformation` 的高 16 位；该值随后出现在
`KBDLLHOOKSTRUCT.dwExtraInfo`。这样 Axonkey 可以继续使用 `WH_KEYBOARD_LL`，按 `UniqID`
判断事件是否来自 RC003，对目标事件返回非零，并用 `SendInput` 输出映射结果。源码 MIT，另有
付费 WHQL 包。一个非官方
[PowerToys Keyboard Manager 分支](https://github.com/Applet-LLC/PowerToys-KeyboardManager-MultiKeyboard)
已经实现了这种 capture backend，可作为集成参考。

这条路线比 OpenInputBridge 更接近 fail-open：驱动始终把原输入向上传递，只由用户态 hook
决定是否吞键；应用退出或 hook 被移除后，键盘自然恢复原行为。但它仍安装 class filter，且输出
仍受 `SendInput` 的 UIPI 限制，低层 hook 还必须满足 Microsoft 文档规定的回调时限。

#### 对 RC003 的决定性限制

官方 [1.00 release](https://github.com/Applet-LLC/addid/releases/tag/1.00) 明确写明：部分设备可能
无法获得 `UniqID`，Bluetooth 设备会因初始化时序出现 ID 一直为 0 的情况，并且不保证总能赋值。
这正好落在 RC003 的连接形态上。其公开付费包只声明 Windows 11 24H2，公开许可还限定驱动文件
只用于一台 PC，禁止转让或销售，不能视作 Axonkey 的 OEM 再分发授权。

**结论：只值得做一个短实验。** 在改 Axonkey 主路径前，先用上游 DriverTestApp 连续观察 RC003
的首次连接、100 次 idle 重连、forget/pair 和 sleep/wake；任何一次 `UniqID == 0` 或身份变化即淘汰。
即使实机通过，也仍需单独取得 OEM 授权并补齐 Windows 10/11、hook 超时和高完整性窗口测试。

### 5. 自研 KMDF 设备过滤驱动

#### 已确认的 Windows 支持路径

Microsoft 明确允许 keyboard/mouse filter 作为 `kbdhid`/`mouhid` 或
`kbdclass`/`mouclass` 的上层过滤器，并建议新驱动使用 KMDF/UMDF 而不是 WDM，见
[Developing keyboard and mouse HID client drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/hid/keyboard-and-mouse-hid-client-drivers)。

官方 [`kbfiltr` sample](https://github.com/microsoft/Windows-driver-samples/tree/main/input/kbfiltr)
展示了替换 `IOCTL_INTERNAL_KEYBOARD_CONNECT` 的 class service callback；callback 可以丢弃、修改或
插入 `KEYBOARD_INPUT_DATA`。样例还明确说明：设备过滤器可只过滤一个键盘，class filter 才会覆盖所有
键盘。样例本身偏 PS/2，不能原样当作 RC003 成品驱动。

Windows 10 1903+ 支持在匹配设备的 INF 中用声明式
[`AddFilter`](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/inf-addfilter-directive)
注册设备级 upper/lower filter，也支持 Extension INF。具体绑定 RC003 的哪一个
`HID\VID_2717&PID_32B8&COLxx` 键盘 TLC，仍需在实机枚举树上确定。

#### 推荐的 Axonkey 专用设计

以下是**设计建议，不是已实现事实**：

```text
RC003 keyboard TLC only
  -> Axonkey KMDF upper device filter
       default: immediately call original ClassService (fail open)
       active lease + mapped source key: queue event to user mode, suppress original
       no lease / file close / process crash / heartbeat timeout: pass through
  -> kbdclass

Axonkey service
  <- bounded driver event queue
  -> existing gesture/mapping engine
  -> SendInput, or a narrowly scoped driver output IOCTL
```

关键约束：

- 每个到达的 `WDFDEVICE` 自带状态，不使用跨设备固定槽数组；cleanup 完整释放状态。
- INF 尽量只绑定 RC003 键盘 TLC；若实际 Windows HID 栈迫使使用 class filter，则
  `EvtDeviceAdd` 查询 PDO 属性，非 RC003 实例永远只透传且不暴露控制接口。
- 驱动启动、无客户端、禁用、句柄 cleanup、队列满、协议版本不匹配、heartbeat 超时全部 fail-open。
- 内核层只做有限状态和有界队列，不执行文本粘贴、命令或复杂宏。
- 用户态只允许打开 RC003 控制接口；使用 ACL，避免 OpenInputBridge/Interception 那种普通用户进程
  可观察全部键盘的兼容性攻击面。
- 输入与输出协议带版本、长度和上限；所有 IOCTL 做严格校验和 fuzz/Driver Verifier 测试。

#### 签名、发布和许可证

普通 Secure Boot Windows 上不能发布自签名或 test-signed 内核驱动。Microsoft 文档说明 Windows 10
开始内核驱动必须经 Hardware Dev Center 签名；面向 retail 的 attestation signing 当前只保留给测试
场景，生产应走 HLK/WHCP/WHQL。见
[driver signing policy](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-)、
[attestation signing](https://learn.microsoft.com/en-gb/windows-hardware/drivers/dashboard/code-signing-attestation)
和 [Hardware Program 注册要求](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/hardware-program-register)。
注册组织需要 EV certificate、Entra ID 管理员和法务协议；每次生产驱动包重建后都需要重新提交微软签名。

微软 Windows driver samples 使用
[MS-PL](https://github.com/microsoft/Windows-driver-samples/blob/main/LICENSE)：可商用和发布二进制，
但复制源码时要保留通知，源码形式分发时该部分须继续遵循 MS-PL。Axonkey 自己从接口文档独立实现的部分
可以采用项目自己的许可证。

**成本判断：** 代码本身是中等规模；真正高成本在 Windows HLK 矩阵、签名供应链、安装/升级/卸载
恢复、Driver Verifier、蓝牙/Modern Standby 实机兼容和长期维护。

### 6. Windows 内置 Keyboard Filter (WEKF)

Windows Keyboard Filter 可以按 virtual key 或 scan code 屏蔽键和组合，但它会跨硬件键盘、屏幕键盘、
触摸键盘合并判断，甚至支持组合键来自多个键盘。这个特性反向证明它不是 per-device API。它还只在
IoT Enterprise、Enterprise/LTSC、Education 等特定版本提供，不覆盖普通 Home/Pro 安装。
见 Microsoft [Keyboard Filter](https://learn.microsoft.com/en-us/windows/configuration/keyboard-filter/)
和 [`WEKF_CustomKey.Add` supported editions](https://learn.microsoft.com/en-us/windows/configuration/keyboard-filter/wekf-customkeyadd)。

**结论：** 适合 kiosk 锁定，不适合 RC003 单设备映射。

### 7. HidHide / ViGEm 生态

HidHide 是 MIT 的签名 HID/XInput “device firewall”，能按设备实例阻止传统 Win32 进程打开 HID，并给
白名单 feeder 放行，见上游
[README](https://github.com/nefarius/HidHide/blob/master/README.md)
和 [API docs](https://docs.nefarius.at/projects/HidHide/API-Documentation/)。它主要解决 gamepad
物理输入与 ViGEm 虚拟 gamepad 双输入。

但 RC003 的原始按键已由 `kbdhid`/`kbdclass` 系统键盘栈消费，不是普通应用直接打开 HID 得到的
gamepad 数据。HidHide 维护者也明确表示它不能阻止通过其他通道读取设备的 Windows core services，见
[项目 Q&A](https://github.com/nefarius/HidHide/discussions/133)。上游对键盘场景的
[issue #15](https://github.com/nefarius/HidHide/issues/15) 也记录了选中 HID 键盘设备后数字仍正常进入编辑器。

ViGEmBus 只创建虚拟游戏控制器，不创建系统键盘，也不负责屏蔽物理键盘。即便 HidHide 能让 Axonkey
读取 RC003 的 raw HID，它仍不能证明原 keyboard class 事件被可靠抑制。

**结论：** 不作为 RC003 键盘后端；引入两个通用驱动反而扩大安装和恢复风险。

### 8. 其他现成 remapper 的后端审计

- **keymapper：** 上游明确写明 Windows `device`/`device-id` 过滤必须安装 Interception，并直接警告
  其断开多次后设备停止工作的严重缺陷；无驱动时仅用全局 hooks。见
  [keymapper README](https://github.com/houmain/keymapper#virtual-device-driver)。因此不构成替代，且本体
  为 GPL-3.0。
- **KMonad：** Windows 教程明确使用 low-level hook 收所有非注入键盘事件，并用 SendEvent 输出；只有
  Linux/macOS 后端有按设备路径/名称选择。见
  [KMonad tutorial](https://github.com/kmonad/kmonad/blob/master/keymap/tutorial.kbd)。不满足 R1。
- **KeyMagic 3：** Windows 实现是 TSF IME，处理文本 composition，而不是物理 HID 设备过滤；见
  [KeyMagic 3 architecture](https://github.com/thantthet/keymagic-3)。方向不匹配，且为 GPL-2.0。
- **PowerToys Keyboard Manager：** 使用全局 low-level hook；其设计文档反而指出只有驱动方案才有机会
  区分键盘，并因系统级副作用放弃该方向。见
  [PowerToys design](https://github.com/microsoft/PowerToys/blob/main/doc/devdocs/modules/keyboardmanager/keyboardmanager.md)。
- **PowerToys-KeyboardManager-MultiKeyboard：** 非官方分支已接通 OIB 与 kbdaddid，适合作为直接
  IOCTL 客户端和 capture backend 的参考；但其 README 明确标注“每个键盘使用不同映射规则”尚未实现，
  且不负责安装或授权驱动，因此不是可直接交付的替代品。
- **Nodoka：** 是独立的完整 remapper；其多键盘识别依赖另售的 `kbdaddid.sys`，因此继承上述
  Bluetooth 身份和分发限制，也不能作为 Axonkey 的无驱动 SDK 直接嵌入。
- **DeviceMapper：** README 宣称 per-device `block`，但固定提交源码注册 Raw Input 时仅使用
  `RIDEV_INPUTSINK | RIDEV_PAGEONLY | RIDEV_DEVNOTIFY`，没有拦截驱动或 keyboard hook；所谓 ignored/
  mapped 只是在自身 callback 返回，Windows 原事件早已沿正常路径送出。见
  [`raw_input.py`](https://github.com/HiMindAi/DeviceMapper/blob/cedd49c48741b8bd30e4260ecf4a9c61b806d289/raw_input.py#L869-L883)
  和 [`mapper_engine.py`](https://github.com/HiMindAi/DeviceMapper/blob/cedd49c48741b8bd30e4260ecf4a9c61b806d289/mapper_engine.py#L194-L221)。
- **`xps15kbfix`：** 证明 KMDF callback 能对各键盘分别改包，并声称支持 HID USB/Bluetooth；但需要改源码、
  手工注册 class filter 和本地证书，没有微软签名产品包。见
  [upstream README](https://github.com/valinet/xps15kbfix)。只能作为 PoC 参考。

## 推荐执行顺序

### Phase A：OpenInputBridge 商业与二进制尽调

在写产品代码前拿到以下书面答案和工件：

1. WHQL `oib_kbd.sys/.inf/.cat` 与安装器，核验签名链、版本和文件哈希；
2. Axonkey 安装包内再分发权，覆盖用户数量、地区、离线使用、订阅终止、更新和安全修复；
3. Windows 10 22H2 是否受支持；Windows 11 24H2/25H2、HVCI/Memory Integrity 是否在测试范围；
4. 上游是否做过 Bluetooth HID surprise removal/rearrival、Modern Standby 和 Driver Verifier；
5. 是否能只安装 keyboard half；当前 README 的默认架构要求键盘和鼠标两部分同时安装，需要明确产品版差异；
6. 安全接口是否能加 ACL 或只允许 Axonkey，而不是保留任意普通进程观察/注入所有键鼠的兼容接口。

任一关键项无法获得明确答复，不应将购买个人版等同于获得产品分发权。

### Phase B：隔离 PoC

保持 Axonkey 映射代码不变，只替换测试机驱动和安装检测。不要先改发布安装器。PoC 必须记录：

- 驱动/INF/catalog/安装器签名和版本；
- 每次 RC003 到达/移除的 PnP instance path、hardware ID、分配槽号；
- 目标过滤启用前后的普通键盘和 RC003 实际输出；
- Axonkey 退出、kill、崩溃、冻结时的后续透传行为；
- 卸载并重启后 RC003 和普通键盘均恢复 inbox driver 栈。

### Phase C：不通过则启动专用 KMDF 驱动

先在 test-signing 隔离机验证 RC003 的确切 keyboard TLC 和 device-specific INF 绑定；只有 PnP、fail-open
和卸载恢复都稳定后再投入 Partner Center/HLK。不要通过关闭 Secure Boot 或让用户安装自签根证书绕过发布签名。

## 发布验收门槛

以下测试当前**均未执行**，不能用短时间“能映射”替代：

| 类别 | 最低验收 |
| --- | --- |
| OS | 干净 Windows 10 22H2 x64；Windows 11 24H2/25H2 x64 |
| 安全配置 | Secure Boot 开启；Memory Integrity 开启与关闭各一轮 |
| 自动重连 | RC003 idle 断开/重建至少 100 次，期间每轮验证原键或映射键实际到达 |
| 手工 PnP | reset 20 次；forget/pair 10 次；Bluetooth toggle 20 次 |
| 电源 | sleep/wake、hibernate/wake、Modern Standby 各 20 次（硬件支持项） |
| 槽位/实例扰动 | RC003 休眠期间插拔另一把键盘，确保普通键盘绝不被捕获 |
| 失败透传 | disabled、正常退出、强杀、崩溃、进程冻结、队列满分别验证 |
| 并发输入 | 普通键盘持续输入时操作 RC003，零误吞、零误映射 |
| 映射语义 | preserve-original、disabled、单键、四键 chord、单双击、长按、repeat |
| 安装生命周期 | 安装、覆盖升级、回滚、卸载、失败中断；最终 inbox 键盘输入可用 |
| 驱动质量 | Driver Verifier、HLK/WHQL 对应目标 OS，零 bugcheck、零资源泄漏 |

判定成功必须基于实际按键输出和设备栈证据；“设备管理器显示 OK”“蓝牙显示已连接”或用户态能重新创建
context 都不算通过。

## 最终建议

**短期：购买/取得 OpenInputBridge 1.00 WHQL 的评估权并做隔离 PoC，是最省代码且最有信息增益的下一步。**
它若通过 RC003 重连矩阵且获得明确 OEM 再分发授权，可以保留 Axonkey 现有映射引擎快速迁移。

**长期：对消费级发布，Axonkey 专用、只绑定 RC003、带 heartbeat fail-open 的 KMDF 驱动更符合产品边界。**
OpenInputBridge 的全键鼠 class filter、公开兼容控制接口和付费第三方签名供应链都是持续风险。若 PoC
暴露任一槽位竞态、挂死不透传、安全接口或授权问题，应停止在兼容层上继续打补丁，转入专用驱动设计。
