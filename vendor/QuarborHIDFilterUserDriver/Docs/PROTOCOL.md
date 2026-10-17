# QuarborHIDFilterUserDriver

UMDF 2.33 用户态 HID 键盘过滤器。驱动保持通用，不按 VID/PID、设备型号、Axonkey 或特定修饰键实现逻辑。它安装在 kbdhid 与 HID 传输层之间，每个设备实例提供一个本机命名管道。

## 双向报告处理

一次物理 HID 输入报告只允许一个待决事务。下层读取完成时，驱动立即复制报告并从原读取缓冲区清零；截止期限从捕获时刻开始。只有已完成握手的客户端才能收到 `ReportRequest`。客户端必须原样回传 `sessionId + sequence`，并提交长度相同、Report ID 相同且不超过原请求容量/请求长度和协议上限的 HID 报告。

合法回复会重新取得原 `WDFREQUEST` 的输出缓冲区，确认取消状态后写入替换报告，并以 `STATUS_SUCCESS` 和报告长度完成请求。驱动完成请求后不再访问该请求或缓冲区。

无客户端、握手未完成、发送失败、超时、断连、队列溢出或无效回复都会清零原有效缓冲区，把原请求重新放入有界重试队列，并继续下层读取；清零后的请求不会以“成功、零字节”交给 kbdhid。原请求被取消或设备停止时完成 `STATUS_CANCELLED`，不再重新下发。底层读取错误沿用原错误路径。

首版每设备串行处理一份下层读取或一份等待回复的报告；上层可取消读取在显式 64 条有界重试队列中等待，溢出按屏蔽/忙状态计数。物理报告可能在等待客户端时积压，因此应测量快速按下/释放和高频报告。所有管道 I/O 使用独立的读写 `OVERLAPPED`、事件和副本缓冲区；管道线程不保存原 WDF 请求缓冲区指针。

## 管道和协议

管道名为 `\\.\pipe\Quarbor.HidUserFilter.v2.<实例 ID 的 UTF-16LE FNV-1a 64 位哈希>`。使用 `PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED`、字节流模式和 `PIPE_REJECT_REMOTE_CLIENTS`，每设备只接受一个本机客户端。交互用户具备读写权限以完成握手和回复，仍不授予远程客户端访问。

当前发布面只保留 v2。驱动不创建、不监听也不接受旧的 `Quarbor.HidUserFilter.v1.*` 管道或 QHF1 帧；客户端必须使用 v2 前缀并完成 v2 握手。

公共协议定义在 `shared/include/QuarborHidUserProtocol.h`，发布 SDK 会复制该文件。所有字段是固定宽度小端整数。64 字节固定头部字段偏移如下：

| 偏移 | 字段 | 类型 |
| --- | --- | --- |
| 0 | magic | uint32 |
| 4 | version | uint16 |
| 6 | type | uint16 |
| 8 | headerBytes | uint32 |
| 12 | payloadBytes | uint32 |
| 16 | sessionId | uint64 |
| 24 | sequence | uint64 |
| 32 | timestamp | uint64，单调时钟 100ns |
| 40 | timeoutMs | uint32 |
| 44 | deadlineMs | uint32，单调毫秒 |
| 48 | status | uint32 |
| 52 | flags | uint32 |
| 56 | reserved[2] | uint32[2] |

消息方向和用途：`Hello`（驱动→客户端，实例身份）、`ClientHello`（客户端→驱动，协议和能力）、`ReportRequest`（驱动→客户端，原始报告）、`ReportReply`（客户端→驱动，替换报告）、`ReplyResult`（驱动→客户端，接受/过期/无效等）、`Status`（驱动→客户端，状态和分类统计）。客户端必须先校验固定头部和载荷长度，再读取载荷；无法确定边界的损坏帧会断开并屏蔽待决报告。取消部分发送的帧后必须重建会话。

报告按原始 HID 字节处理，保留 Report ID，不解释成 VK、扫描码或文本。当前驱动验证范围是长度、请求容量/长度、协议上限、Report ID 和当前 collection 已知的布局；不能仅凭长度声称所有 HID 字段都合法。合法的全释放报告照常接受。

## SDK

`application/QuarborHIDFilterUserDriverTest/include/ReportClient.h` 和 `src/ReportClient.cpp` 提供：枚举和双向连接、异步字节流拆包、自动/显式握手、接收原始报告、按事务标识提交替换报告、接收 `ReplyResult`、`Cancel`、关闭和重连。`Pump` 不阻塞等待完整帧；`Close` 会取消未完成读取并等待其退出。

示例流程：

```cpp
quarbor::user_filter::ReportClient client;
if (client.Connect(path) == ERROR_SUCCESS) {
    quarbor::hid_user::Packet packet{};
    while (client.Pump(packet) != quarbor::user_filter::ReportClient::Result::Error) {
        if (packet.header.type == quarbor::hid_user::Hello) {
            client.Handshake();
        } else if (packet.header.type == quarbor::hid_user::ReportRequest) {
            // 应用按描述符处理 packet.payload 后提交一份同长度报告。
            client.SubmitReply(packet, packet.payload, packet.header.payloadBytes);
        }
    }
}
```

替换报告必须使用对应事务的会话 ID 和序号。`ReplyResult::ReplyAccepted` 表示驱动已经完成交付，不表示上层应用已经执行动作。

## 生命周期和测试

设备停止时依次关闭新事务入口、终止待决事务和管道 I/O、取消下层读取、排空队列，再等待回调和工作项退出。锁内不等待管道或回调，也不使用 `WdfRequestReuse` 重置取消状态。

真实管道测试位于 `application/QuarborHIDFilterUserDriverTest/tests`，安全和 WDF 边界测试位于 `drivers/QuarborHIDFilterUserDriver/tests`。测试需覆盖拆包/粘包、迟到和重复回复、超时、断连、取消、停止、溢出、快速按下/释放及多种 HID 报告布局。构建和签名方法见仓库 `docs/development.md`。
