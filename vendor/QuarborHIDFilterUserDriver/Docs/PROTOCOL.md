# QuarborHIDFilterUserDriver 0.3.0

UMDF 2.33、Windows 11 22H2 x64，Desktop 驱动。本版用于手动选择标准 kbdhid HID 键盘集合。
INF 的私有模型 ID 为 `QUARBOR\HidKeyboardManualBinding`，不自动匹配任何物理键盘；
GUI 在指定 INF 的类驱动列表中显式选择该模型，再通过 DiInstallDevice 安装到选中的设备实例。
不使用系统保留的通配 HID ID，不是全局 Keyboard 类过滤器。
USB/蓝牙键盘分别需要真机验证，PS/2 和自定义功能驱动栈不在本版支持范围。
驱动报告采集代码没有 VID/PID 限制，沿用 0.2 的原始报告与命名管道实现。
安装/恢复记录、旧版迁移和测试步骤见 GUI 的 README.md（发布包根目录）。

## 输入拦截与采集

INF 保留 keyboard.inf / kbdhid 功能驱动，通过 WUDFRD_LowerFilter 安装 UMDF 下层过滤器。
输入路径是 kbdhid → WUDFRd/UMDF → HID collection。IRP_MJ_READ 向下发送时保留原始
文件对象和取消状态；完成回调复制原始输入报告，然后清零已消费的缓冲区，将原请求放入
手动队列，由工作项重新向下读取。任何原始按键报告都不会成功完成给 kbdhid。
不使用 WdfRequestReuse（会重置调用者的取消标志），也不在完成回调中递归提交读取。
公开的 IOCTL_HID_GET_INPUT_REPORT 仍返回拒绝访问；描述符、Feature/Output 控制继续转发。
错误/取消只返回失败状态和零长度，不伪造空成功报告。

生命周期：SelfManagedIoSuspend 关闭新读取入口，取消下层 I/O，等待完成回调退出，
排空工作项/队列并停止管道线程；恢复时重启。拔出与清理也关闭管道和线程。
普通客户端连接、退出或停止接收不会解除拦截。采集依赖系统 kbdhid 已发起读取请求。

## 通信选择

使用本机单向命名管道，不在系统独占的键盘设备栈上再要求普通客户端打开自定义 IOCTL。
无需另装服务、内核控制设备或本机 TCP 端口。使用 Windows Desktop API，因此项目目标
为 Desktop，并不声称通过 Universal Driver API 验证。

管道路径：`\\.\pipe\Quarbor.HidUserFilter.v1.<16位十六进制设备实例哈希>`。
哈希为大小写折叠的设备实例 ID 的 UTF-16LE FNV-1a 64 位值。同型号不同实例分别发布。
客户端可以枚举 `\\.\pipe\*` 并过滤前缀，连接后从 Hello 读取完整设备实例 ID。
提供的 `ReportClient::Enumerate/Connect/Pump/Close` 实现可直接用于普通 Win32 程序。

每个设备同时允许一个客户端；第二个客户端得到 Win32 231 (ERROR_PIPE_BUSY)。
普通交互登录用户通过 IU ACL 获得只读权限，不要求管理员；本地不同登录会话的交互用户
均在该授权范围内。拒绝网络管道客户端，未授予 Everyone/Anonymous 访问权限。
SY/LS/BA/RC ACE 供系统、LocalService、管理员及 UMDF 受限宿主使用。
服务端使用 FILE_FLAG_FIRST_PIPE_INSTANCE 避免意外接入同名服务器。
客户端以 SECURITY_IDENTIFICATION 打开，不向服务端提供模拟权限。
该接口面向本机可信交互程序，协议本身不提供服务端身份认证。

## 二进制协议 v1

公共定义：`shared/include/QuarborHidUserProtocol.h`（发布包中的 `SDK/QuarborHidUserProtocol.h`）。
小端序、固定 48 字节 Header，紧接 payloadBytes 字节。管道是**字节流**，必须处理
拆包/粘包，不能假定一次 ReadFile 等于一份报告。所有长度都需要在读取载荷之前校验。

| 偏移 | 字段 | 类型 | 含义 |
| --- | --- | --- | --- |
| 0 | magic | uint32 | 0x31464851，字节 QHF1 |
| 4 | version | uint16 | 1 |
| 6 | type | uint16 | 1 Hello；2 Report；3 Status |
| 8 | headerBytes | uint32 | 48 |
| 12 | payloadBytes | uint32 | 0～4096，具体限制见下 |
| 16 | sequence | uint64 | 该设备对象累计观察到的非空、合法下层报告数 |
| 24 | timestamp | uint64 | UTC FILETIME，1601-01-01 起的 100ns 单位 |
| 32 | dropped | uint64 | 驱动已知的累计丢弃报告数 |
| 40 | status | uint32 | 最近一次下层读取 NTSTATUS；Report 为 0 |
| 44 | reserved | uint32 | 0 |

连接后第一帧为 Hello：载荷是以 NUL 结尾的 UTF-16LE 设备实例 ID，长度为偶数且至少为 2。
Report：载荷为完整原始 HID 输入报告，1～4096 字节，**保留 Report ID 字节**，包含按下、
释放、修饰键及设备私有字节。不将其解释为 ASCII、Windows VK 或扫描码，也不假定是
固定 8 字节的 Boot Keyboard 格式；按键语义需依据设备报告描述符解析。
Status：无载荷；空闲时约每秒发送一次，用于显示读取错误、累计报告和丢弃计数。

64 个报告的环形缓冲区位于驱动侧；没有客户端时直接丢弃，慢客户端使队列满时丢最旧报告。
大于 4096 字节的报告整份丢弃（不截断），仍阻止输入到 Windows，并递增 sequence/dropped。
断连时清空残留队列，新连接不重放历史。单次管道写入超过 1 秒则取消并断开慢客户端。
报告回调只复制到缓冲区，永远不等待管道 I/O。

dropped 包含未连接时、大于长度上限、环形队列覆盖、断连清队列、失败写入的丢弃数量。
成功写入 Windows 管道缓冲区但客户端未读就退出的报告无法得到应用确认，不计入这个数。
这是实时观察接口，不是无损记录器；序号跳变表示缺帧，设备对象重建后计数从零开始。
时间戳在报告采集时生成；Hello/Status 使用帧生成时间。掉线后应关闭句柄、重新枚举/连接。

## 上位机接入

复制发布目录 SDK 中的三个文件到项目并编译 ReportClient.cpp，使用 C++17、Unicode、
_WIN32_WINNT=0x0A00，链接常规 Kernel32，无需 WDK 或管理员权限。

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

本地构建、Inf2Cat 和独立命名管道测试不会安装驱动。测试覆盖真实管道通信、禁用管理员
SID/权限后的客户端访问、原始字节、报告 ID、释放报告、溢出、连接竞争、分片、错误帧、
断线重连和挂起 I/O 的取消。它们不代替目标蓝牙设备与 UMDF 宿主的实机验证。
目标电脑仍需验证持续按键/释放报告、Windows 无输入、蓝牙重连、睡眠恢复、拔出和卸载。

参考：
- Microsoft [WDF 完成回调](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdfrequest/nf-wdfrequest-wdfrequestsetcompletionroutine)
- Microsoft [WdfRequestReuse 取消注意事项](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdfrequest/nf-wdfrequest-wdfrequestreuse)
- Microsoft [命名管道访问权限](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- Microsoft [Self-managed I/O](https://learn.microsoft.com/en-us/windows-hardware/drivers/wdf/using-self-managed-i-o)

