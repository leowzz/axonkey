# QuarborHIDFilterUserDriver 0.4.0

UMDF 2.33、Windows 11 22H2 x64，Desktop 驱动。本版用于手动选择标准 kbdhid HID 键盘集合。
INF 的私有模型 ID 为 `QUARBOR\HidKeyboardManualBinding`，不自动匹配任何物理键盘；
GUI 在指定 INF 的类驱动列表中显式选择该模型，再通过 DiInstallDevice 安装到选中的设备实例。
不使用系统保留的通配 HID ID，不是全局 Keyboard 类过滤器。
USB/蓝牙键盘分别需要真机验证，PS/2 和自定义功能驱动栈不在本版支持范围。
驱动报告采集代码没有 VID/PID 限制，保留原始 HID 报告语义，通信升级为 Protobuf v3。
安装/恢复记录和测试步骤见 GUI 的 README.md（发布包根目录）。

## 代码组织

DLL 文件属性由 `QuarborHIDFilterUserDriver.rc` 定义。文件版本和产品版本均使用项目中的
`Inf.TimeStamp` 配置（当前 `0.4.0.0`），构建时同步生成数字/字符串版本并用于 INF 盖戳，
无需再在资源文件中手动维护版本号。

| 文件 | 职责 |
| --- | --- |
| `src/Driver.cpp` | 注册设备创建回调的驱动入口 |
| `include/Device.h` | 设备上下文及模块间声明 |
| `src/Device.cpp` | 设备创建、实例 ID、启动/挂起/清理生命周期 |
| `src/IoQueue.cpp` | 上层 READ 手动队列、输入 IOCTL 拦截、控制与写入请求转发 |
| `include/HidReader.h`、`src/HidReader.cpp` | 独立下层文件、自有读取请求/缓冲区、异步采集线程和失败退避 |
| `include/InputQueue.h`、`src/InputQueue.cpp` | Pipe 注入队列、上层 READ 交付、Report ID 能力和释放收尾 |
| `include/ReportPipe.h`、`src/ReportPipe.cpp` | 固定容量报告队列、双工管道、连接和异步 I/O 取消 |
| `shared/include/QuarborHidUserProtocol.h` | 进程内数据及有界容量，诊断存在性由单一位图表示 |
| `shared/src/QuarborHidUserCodec.cpp` | 帧编码、方向和字段校验、诊断映射 |
| `shared/include/QuarborHidUserMemory.h` | 定长临时数据的作用域擦除，统一提前返回的清理 |

挂起时先关闭控制请求入口、停止管道及注入工作线程，再排空上层 READ，
停止采集并等待下层 I/O 和回调退出，最后排空控制队列。
采集线程是唯一的读取提交者，停止后不会再次提交；管道锁保护报告队列与统计，锁内不等待管道 I/O。
报告出队只复制头部和有效载荷，避免短 HID 报告也复制整个 4 KB 缓冲区。
报告环只保存 Header 和原始字节，不在每个槽中预留 Hello/诊断数据。
命令路径分为收帧校验、业务执行、回执入队；字段校验在解码层完成，输入队列仍独立验证直接调用。

## 输入拦截与采集

INF 保留 keyboard.inf / kbdhid 功能驱动，通过 WUDFRD_LowerFilter 安装 UMDF 下层过滤器。
采集从 SelfManagedIoInit/Restart 启动，不依赖 kbdhid 是否发出 READ，也不依赖 pipe 客户端连接。
HidReader 使用 WdfIoTargetOpenLocalTargetByFile 从过滤器下方打开 HID collection，获得私有文件对象；
不能直接向默认 target 发送没有文件对象的自建读取。上层 CREATE 在本过滤器成功完成，
cleanup/close 也不转发，以免上层句柄与私有采集句柄争抢独占访问或互相关闭。

启动时通过 IOCTL_HID_GET_COLLECTION_INFORMATION / IOCTL_HID_GET_COLLECTION_DESCRIPTOR 查询 preparsed data，
使用 HidP_GetCaps 的 InputReportByteLength 分配实际读取缓冲区；不假定固定 8 字节。
每设备预分配一个自有 WDFREQUEST 和 WDFMEMORY；采集线程格式化 READ、设置完成回调并异步下发。
完成回调只在成功且长度为 1～缓冲区容量时发布原始报告，然后清零缓冲区、重置自有请求并唤醒线程。
下一次读取由线程提交，避免同步完成导致递归。WdfRequestReuse 仅用于自建请求，不改变上层请求的取消状态。
读取/提交失败后等待 100ms 再试，停止事件可立即打断退避；重置请求失败则结束本轮采集并保留错误状态。
启动查询、分配或打开失败直接使设备启动失败，不回退到借用 kbdhid READ。

kbdhid 发来的 READ 始终保留在独立手动队列中，由 WDF 处理取消；不下发给 HID、不提供原始报告或空成功报告。
公开的 IOCTL_HID_GET_INPUT_REPORT 仍返回拒绝访问；描述符、Feature/Output 控制和 Output 写入
使用私有下层 target 转发。控制请求失败时返回失败状态和零 Information。

生命周期：SelfManagedIoSuspend 先关闭控制队列入口，停止管道和注入工作线程，再排空上层 READ 队列；
采集线程退出前执行目标 PurgeIoAndWait，并显式等待读取回调的完成事件，确保回调已经结束缓冲区访问和请求重置。
线程退出后才删除自有请求、擦除并释放缓冲区、关闭下层文件，最后排空控制队列。
恢复时重新打开并查询能力、重建采集资源。拔出与清理也停止采集和管道。
普通客户端连接、退出或停止接收不会解除拦截；无订阅者时沿用直接丢弃并计数的实时采集策略。

## 通信选择

使用本机双工命名管道，不在系统独占的键盘设备栈上再要求普通客户端打开自定义 IOCTL。
无需另装服务、内核控制设备或本机 TCP 端口。使用 Windows Desktop API，因此项目目标
为 Desktop，并不声称通过 Universal Driver API 验证。

管道路径：`\\.\pipe\Quarbor.HidUserFilter.v3.<16位十六进制设备实例哈希>`。
哈希为大小写折叠的设备实例 ID 的 UTF-16LE FNV-1a 64 位值。同型号不同实例分别发布。
客户端可以枚举 `\\.\pipe\*` 并过滤前缀，连接后从 Hello 读取完整设备实例 ID。
提供的 `ReportClient::Enumerate/Connect/Pump/Close` 实现可直接用于普通 Win32 程序。

每个设备同时允许一个客户端；第二个客户端得到 Win32 231 (ERROR_PIPE_BUSY)。
普通交互登录用户通过 IU ACL 获得读写权限，不要求管理员；本地不同登录会话的交互用户
均在该授权范围内。拒绝网络管道客户端，未授予 Everyone/Anonymous 访问权限。
SY/LS/BA/RC ACE 供系统、LocalService、管理员及 UMDF 受限宿主使用。
服务端使用 FILE_FLAG_FIRST_PIPE_INSTANCE 避免意外接入同名服务器。
客户端以 SECURITY_IDENTIFICATION 打开，不向服务端提供模拟权限。
该接口面向本机可信交互程序，协议本身不提供服务端身份认证。

## Protobuf 协议 v3

权威线上定义：`shared/proto/hid_user.proto`，包名 `quarbor.hid.v3`。
`shared/include/QuarborHidUserProtocol.h` 中的 Header/Packet/能力/诊断仅是进程内 DTO，
不得发送其内存布局或依赖 sizeof。

每帧为 **4 字节小端无符号长度 N + N 字节 Protobuf 消息**。N 必须为 1～8192，
先验证长度再读取正文；完整 HID 报告仍为 1～4096 字节，4096 不包含 Protobuf 开销。
拆包/粘包均按前缀处理，不能假定一次 ReadFile 对应一帧。Protobuf 内部使用自己的标准 wire encoding。
从收到帧的首批字节起，完整命令必须在 1 秒内收齐；空闲连接可等待。出站写入限时 1 秒。
客户端 Pump 也限制已开始接收但未完成的帧；取消后等待异步 I/O 完成才释放缓冲区。

| 方向 | 消息体 | 含义 |
| --- | --- | --- |
| 客户端 → 驱动 | inject_report | 完整输入 HID 报告，长度必须等于能力中 input_report_bytes，含 Report ID 槽位 |
| 客户端 → 驱动 | inject_key | usage_page、usage、action；可选 report_id 缺省时自动选唯一匹配 |
| 客户端 → 驱动 | reset_input | 清空待交付输入并安排描述符定义的中性报告 |
| 客户端 → 驱动 | query_diagnostics | 查询包含计数、队列状态和 READ 细节的统一诊断消息 |
| 驱动 → 客户端 | hello | UTF-8 instance_id，无 NUL，最多 511 个 UTF-16 code unit；SDK 转为 UTF-16 |
| 驱动 → 客户端 | capabilities | 报告长度、队列容量、能力 flags、32 字节 Report ID 位图 |
| 驱动 → 客户端 | report | 完整原始 HID 字节，保留 Report ID，按设备描述符解释 |
| 驱动 → 客户端 | status | 空闲时约每秒提供读取状态和计数快照 |
| 驱动 → 客户端 | result | 命令接受/拒绝结果，ntstatus 为 0 或错误状态 |
| 驱动 → 客户端 | diagnostics | 入队、READ 完成/失败、队列状态和最近报告样本，以及可选 READ 细节 |

连接后先 hello，再 capabilities（真实驱动始终配置能力），然后 report/status/响应混合发送。
ClientMessage.request_id 必须非零且同一连接内严格递增，新连接可从 1 开始。
ServerMessage.request_id 只用于 result/diagnostics，回显请求编号；其他消息必须为 0。
report_sequence 单独表示设备对象累计物理报告计数，hello/status 为快照，响应不复用这个字段。
timestamp_filetime 是 UTC FILETIME（1601 年起 100ns 单位）；ntstatus 使用 fixed32 保留错误码位模式。
report 的 ntstatus 为 0，status/hello 可报告下层读取错误。命令结果与 Windows 输入交付相互独立。

capabilities.flags bit 0=非零 Report ID，bit 1=语义按键注入，bit 2=READ 诊断。
无编号 HID 报告也保留零值 Report ID 槽位。InjectKey action=1 按下、2 松开，0/未知枚举无效；
usage_page/usage 必须不超过 65535，显式 report_id 必须不超过 255。
SDK 的 AnyReportId=0xFFFF 只在进程内表示缺省，线上使用 optional 字段的 absence。
语义编码通过 HidP_SetUsages/UnsetUsages，并由 HidP_GetUsages 反向验证；raw/语义模式不能混用，ResetInput 可切换。

diagnostics.last_encoded_report 为固定 32 字节零填充样本。requested_bytes、buffer_bytes、
effective_io_type、requestor_mode 使用 optional 保留“缺省”和“真实为零”的差别，后续可添加字段。
I/O 类型 2=Buffered、3=Direct、0=尚无 READ；来源 0=内核、1=用户、UINT32_MAX=尚无 READ。
SDK Packet.HasReadDetails() 表示四项均存在，readDetailsFields 按位保留各字段存在性。
累计诊断从设备启动开始；ResetInput/断连清除报告样本但不清除计数。

普通未知字段忽略，未知或缺失的消息体、错误方向、非法长度/字段、重复 request_id 则断连。
Protobuf 允许重复字段，oneof 采用标准最终成员语义；必须完整解码和校验后只执行一次最终命令。
不得在解码回调里执行输入操作。语法/字段范围校验失败不触发业务回调；
设备特定报告长度、Report ID、队列满等业务错误通过 result 返回。
新增字段不得复用旧字段编号；删除字段应 reserved；新的命令必须先协商能力再发送。
nanopb 跳过未知字段，驱动是协议终点，不承担保留未知字段并转发的代理职责。

实现使用固定版本 nanopb 0.4.9.2，无 PB_ENABLE_MALLOC。编解码只在管道/客户端线程执行，
采集回调只复制到物理报告队列。生成代码已入库，常规 MSBuild 不需要 Python/protoc/网络。
重新生成：`scripts/Generate-HidUserProtocol.ps1`；加 `-Check` 检查生成结果一致性。
生成器来自同版本 vendored 源码，Python protoc/protobuf 版本由脚本固定。

驱动与客户端统一使用上述 Protobuf 协议，测试包内 EXE 与驱动包应配套使用。
驱动使用 kbdhid 和 CannotUseFsContexts 策略，设备输入仍需针对当前构建进行实机验收。

物理报告和注入报告分别使用 64 项环形队列。物理报告无订阅者时直接丢弃，满时丢最旧报告；
注入队列满则拒绝新命令，不覆盖按下/释放。断连清队列并安排已交付状态的中性报告。
大于 4096 字节的物理报告整份丢弃但仍计入 report_sequence/dropped，不截断、不放行到 Windows。
dropped 包含无客户端、长度上限、覆盖、断连清队列和写入失败；不包含已写入系统管道但客户端未消费的报告。
这是实时观察接口，不是无损记录器。序号跳变表示缺帧，重建设备对象后计数从零开始。

## 上位机接入

发布目录 SDK 含 schema、生成代码、nanopb 运行库、客户端与 CMakeLists.txt。
可用 CMake add_subdirectory 后链接 quarbor_hid_user_client，具体见 SDK/README.md。
C++17、Unicode、_WIN32_WINNT=0x0A00，链接 Kernel32；无需 WDK、protoc 或管理员权限。

```cpp
quarbor::user_filter::ReportClient client;
auto paths = client.Enumerate();
if (!paths.empty() && client.Connect(paths.front()) == ERROR_SUCCESS) {
    // 在 UI 定时器/工作线程中循环调用；Pump 不等待输入。
    quarbor::hid_user::Packet packet{};
    auto result = client.Pump(packet);
    if (result == quarbor::user_filter::ReportClient::Result::Packet &&
        packet.header.type == quarbor::hid_user::Report) {
        // packet.payload[0 .. packet.header.payloadBytes) 是原始报告。
    }
}
```

Pump 每次交付一帧，Waiting 表示暂无完整帧；Error 后使用 Error() 读取 Win32 错误码。
所有客户端方法应在同一线程调用；Close/析构会取消未完成的异步读取并等待取消结束。

## 验证边界

安全审计发现、修复、测试结果及通信权限限制见 [SECURITY_AUDIT.md](SECURITY_AUDIT.md)。
`tests/UserFilterSecurityTests.vcxproj` 覆盖保护页边界、初始化失败注入、资源回收及读取错误处理。
其中 ReaderTests.cpp 运行生产采集线程/回调和真实命名管道，模拟 WDF 下层，验证没有上层 READ
时仍连续采集、报告 ID/释放字节、动态读取长度、同步完成、错误退避、挂起取消、恢复及部分启动失败回收。

本地构建、Inf2Cat 和独立命名管道测试不会安装驱动。测试覆盖真实管道通信、禁用管理员
SID/权限后的客户端访问、原始字节、报告 ID、释放报告、溢出、连接竞争、分片、错误帧、
断线重连和挂起 I/O 的取消。它们不代替目标蓝牙设备与 UMDF 宿主的实机验证。
目标电脑仍需验证私有下层文件打开和真实 UMDF 回调、持续按键/释放报告、Windows 无输入、蓝牙重连、
睡眠恢复、拔出和卸载。模拟 WDF 测试不能证明目标 USB/蓝牙栈接受该打开及读取方式。

参考：
- Microsoft [WDF 完成回调](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdfrequest/nf-wdfrequest-wdfrequestsetcompletionroutine)
- Microsoft [WdfRequestReuse 取消注意事项](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdfrequest/nf-wdfrequest-wdfrequestreuse)
- Microsoft [UMDF 自建请求与下层文件对象](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdfdevice/nf-wdfdevice-wdfdevicegetiotarget)
- Microsoft [OpenLocalTargetByFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdfiotarget/nf-wdfiotarget-wdf_io_target_open_params_init_open_by_file)
- Microsoft [命名管道访问权限](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- Microsoft [Self-managed I/O](https://learn.microsoft.com/en-us/windows-hardware/drivers/wdf/using-self-managed-i-o)

