# QuarborUniversalKeyboardDriver 用户手册

## 1. 功能与使用范围

| 功能 | 使用说明 |
| --- | --- |
| 原始输入采集 | 接收所选 HID 输入源的原始字节，用于客户自己的按键识别、映射或业务逻辑 |
| 物理设备写入 | 向所选物理设备发送原始 Output/Feature 报告，格式由设备协议决定，见第 8 节 |
| 键盘输入 | 使用 HID Usage 发送按下、抬起和组合点击；支持多键同时按住（NKRO），不受传统六键报告限制 |
| 媒体与快捷功能 | 音量、播放控制、应用启动和浏览器导航，完整列表见第 5 节 |
| 鼠标输入 | 左、右、中键，X/Y 相对移动，垂直滚轮与水平滚动；支持拖动 |
| 输入复位 | 清除未交付输入，并安排释放已按住的键与鼠标按钮 |
| 信息与状态查询 | 查询版本、设备身份、能力、数据上限及输入交付状态 |

通用入口面向 Windows 已枚举出的 HID 集合，可用于 USB、经典蓝牙、BLE、I2C 等输入源；具体兼容性取决于设备能否正常枚举和提供输入报告。BLE HID 服务另有父设备安装入口。一个物理设备可以包含多个集合，安装和通信均需选定具体实例。

## 2. 通信连接

### 2.1 端点与权限

通信采用本机 Windows 双向命名管道、字节流模式。每个已绑定设备实例有独立管道，每条管道同时只允许一个客户端。支持本地交互用户连接，连接通常不需要管理员权限；不接受远程连接。

```text
\\.\pipe\Quarbor.UniversalKeyboard.v1.<16位大写十六进制哈希>
```

1. 只将 ASCII `a..z` 转成 `A..Z`；不改变其他字符或路径分隔符。
2. 按 UTF-16LE 编码，排除末尾的 NUL 终止符。
3. 对每个字节计算 64 位 FNV-1a：初值 `14695981039346656037`；每步 `hash = ((hash XOR byte) * 1099511628211) mod 2^64`。
4. 输出宽度为 16、左侧补零的大写十六进制哈希。

实例 ID 必须非空、无内嵌 NUL，最多 511 个 UTF-16 代码单元。连接后还必须核对 `BasicInfo.device_instance_id`，不能仅凭管道名认定设备身份。

Windows 客户端可使用 `CreateFileW`，访问权限为 `GENERIC_READ | FILE_WRITE_DATA`，共享模式为 `0`，打开方式为 `OPEN_EXISTING`，异步客户端使用 `FILE_FLAG_OVERLAPPED`。建议沿用配套客户端的权限组合，避免申请不必要的管道权限。

### 2.2 帧格式

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 字节 | 无符号 32 位小端整数 N，表示 protobuf 载荷长度，不包含这 4 字节 |
| 4 | N 字节 | 一个完整的 `ClientMessage` 或 `ServerMessage` 二进制 protobuf 消息 |

`N` 必须为 `1..66048`，单帧最大总长度为 `66052` 字节。连接后同时检查 `Hello.max_payload_bytes`。字节流不保留消息边界，必须循环读取完整头部和完整载荷，并处理部分写入；一次 `ReadFile` 不等于一帧。

协议定义使用 proto3，包名为 `quarbor.keyboard.v1`，见 [keyboard.proto](keyboard.proto)。应使用此文件生成对应语言的编解码器，不要把 C/C++ 结构体内存直接作为载荷发送。

protobuf 的 `uint32` / `uint64` 使用 varint，`sint32` 使用 ZigZag 编码，`fixed32` / `fixed64` 使用固定长度小端编码，字符串为 UTF-8。未发送的普通标量字段按 proto3 默认值解释。`Key.report_id` 是可选字段：**省略表示自动匹配，显式传 0 不表示自动匹配**。

### 2.3 握手与会话顺序

1. 打开目标管道，接收服务端主动发送的 `Hello`，其外层 `request_id=0`。
2. 验证 `protocol_version=2` 和载荷上限；版本不兼容时关闭连接。
3. 发送 `QueryBasicInfo`，例如 `request_id=1`。
4. 收到相同 ID 的 `BasicInfo` 后，核对驱动名称、完整设备实例 ID 和功能能力。
5. 持续读取服务端消息，根据 `body` 类型分发原始报告、命令回执和状态查询结果，同时按需发送命令。

首次基础信息查询成功后才开始推送物理报告，并清除查询前积压的物理数据；它不是历史报告回放接口。发送输入命令前必须完成基础信息查询。

每次连接中的客户端 `request_id` 必须为非零、严格递增的 `uint64`，所有查询与命令共用此序列，不要求连续。服务端应答携带对应请求 ID；主动推送的 `PhysicalReport` 使用 ID 0。新连接可从 1 重新开始。

服务端消息会混合出现，等待命令回执时也要接收并处理物理报告。客户端须持续读消息；当前帧读写采用约 5 秒超时约束，发送半帧后长时间停顿、无法解码、无效长度或重复/倒退的请求 ID 都可能导致断开。空闲连接没有心跳要求，也没有自动释放按键的空闲计时器。

### 2.4 消息类型

| 方向 | `body` 字段 | protobuf 字段号 | 返回 / 用途 |
| --- | --- | --- | --- |
| 客户端 → 驱动 | `query_basic_info` | 10 | 返回 `basic_info`，首次成功后开始物理报告推送 |
| 客户端 → 驱动 | `keysend` | 12 | 按键操作，返回 `input_result` |
| 客户端 → 驱动 | `mouse_move` | 13 | 相对移动与滚动，返回 `input_result` |
| 客户端 → 驱动 | `reset_input` | 14 | 输入复位，返回 `input_result` |
| 客户端 → 驱动 | `query_input_status` | 15 | 查询交付状态，正常返回 `input_status` |
| 客户端 → 驱动 | `physical_write` | 16 | 向物理设备写报告，返回 `physical_write_result` |
| 驱动 → 客户端 | `hello` | 20 | 首条握手消息 |
| 驱动 → 客户端 | `basic_info` | 21 | 基础信息 |
| 驱动 → 客户端 | `physical_report` | 22 | 主动推送原始报告 |
| 驱动 → 客户端 | `input_result` | 24 | 命令接受 / 拒绝状态 |
| 驱动 → 客户端 | `input_status` | 25 | 交付状态快照 |
| 驱动 → 客户端 | `physical_write_result` | 26 | 物理写入的下层完成状态 |

两种外层消息的 `request_id` 均为字段 1；`body` 为 `oneof`，每条消息只发送一种正文。客户端字段 11、服务端字段 23 已保留，不应使用。对查询也应能够处理失败时返回的 `input_result`。

## 3. 服务端数据解释

### 3.1 Hello 与 BasicInfo

`Hello` 包含 `protocol_version`（uint32，当前 2）和 `max_payload_bytes`（uint32，当前 66048）。

| BasicInfo 字段 | 类型 | 当前值 / 含义 |
| --- | --- | --- |
| `driver_name` | string | `QuarborUniversalKeyboardDriver` |
| `driver_version` | string | 实际运行的驱动版本 |
| `device_instance_id` | string | 本次连接对应的完整设备实例 ID |
| `physical_queue_capacity` | uint32 | 物理报告缓存容量，当前 64 条 |
| `physical_report_max_bytes` | uint32 | 单条原始报告上限，当前 65536 字节 |
| `keyboard_report_id` / `keyboard_report_bytes` | uint32 | 键盘输出报告 ID / 含 ID 的总长度，当前 1 / 30 |
| `media_report_id` / `media_report_bytes` | uint32 | Consumer 输出报告 ID / 总长度，当前 2 / 4 |
| `mouse_report_id` / `mouse_report_bytes` | uint32 | 鼠标输出报告 ID / 总长度，当前 3 / 6 |
| `input_queue_capacity` | uint32 | 输入报告容量，当前 64；单位是报告，不是命令 |
| `supports_keysend` | bool | 是否支持键盘、Consumer 和鼠标按钮操作 |
| `supports_mouse_move` | bool | 是否支持鼠标移动与滚动 |
| `supports_reset_input` | bool | 是否支持输入复位 |
| `supports_input_status` | bool | 是否支持交付状态查询 |
| `supports_physical_write` | bool | 是否提供物理设备写接口；不保证设备支持任意报告 |
| `physical_write_max_bytes` | uint32 | 写入上限，当前 4096，包含首字节 ID 槽位 |
| `physical_output_report_bytes` / `physical_feature_report_bytes` | uint32 | 普通 HID 集合要求的报告总长度；BLE 传输入口为 0，不能据此判断不支持写入 |

旧版本可能缺少能力字段，解码后为 `false` 或 `0`。客户端必须按能力启用功能，不能仅凭 Hello v2 假定所有命令都可用。能力声明不代表设备此刻已准备好接受输入。

### 3.2 PhysicalReport：设备原始数据

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `sequence` | uint64 | 非零采集序号，设备对象生命周期内递增 |
| `timestamp_filetime` | fixed64 | 采集时间，UTC FILETIME：自 1601-01-01 起的 100 纳秒单位 |
| `data` | bytes | 1..65536 字节的原始输入源数据 |
| `queue_overwritten` | uint64 | 物理缓存满时被覆盖的旧报告累计条数 |
| `queue_cleared` | uint64 | 清理缓存时丢弃的报告累计条数 |
| `send_failures` | uint64 | 物理报告发送失败累计次数 |

计数随对应设备对象生命周期累计，不是当前连接的接收量；设备重新创建后可能重新计数。序号可以跳跃，重连后也不保证从 1 开始。缓存满时丢弃最旧物理报告，因此采集不保证无损。

`data` 不使用第 6 节的统一输出布局。客户需依据物理设备自己的报告格式解释它；通用 HID 集合入口会保留 Windows 返回的 Report ID 槽位。不能统一删除首字节，也不能统一将首字节解释成输出报告 ID 1、2、3。

如需转成 Unix 时间：`unix_seconds = (timestamp_filetime - 116444736000000000) / 10000000`。处理 64 位字段时应使用可精确保存 uint64 的类型，例如 JavaScript 的 BigInt，避免转成 Number 后精度丢失。

### 3.3 InputResult：命令结果

`ntstatus` 为 `fixed32`，使用 32 位 NTSTATUS 值，建议以 8 位十六进制显示。

| 值 | 名称 | 含义及处理 |
| --- | --- | --- |
| `0x00000000` | STATUS_SUCCESS | 命令已接受；不表示 Windows 或目标应用已消费 |
| `0x80000011` | STATUS_DEVICE_BUSY | 输入报告缓存已满；继续接收消息，稍后按需用新的请求 ID 重试 |
| `0xC000000D` | STATUS_INVALID_PARAMETER | 空组合、重复键、无效 action 或相对量越界等；修正参数 |
| `0xC00000BB` | STATUS_NOT_SUPPORTED | Usage、report_id 或命令不支持；检查能力与支持列表 |
| `0xC0000184` | STATUS_INVALID_DEVICE_STATE | 尚未完成基础信息查询，或对已按住的键执行 TAP |
| `0xC00000A3` | STATUS_DEVICE_NOT_READY | 输入设备当前未就绪，或 BLE 配套输出设备不可用 |

此表为常见结果。保留并记录未知状态码，不要将它们当成成功。超过 protobuf 接收限制（例如超过 32 个键）或损坏的消息可能直接导致连接关闭，不保证收到参数错误回执。

### 3.4 InputStatus：交付状态

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `active` | bool | 输入交付是否处于活动状态 |
| `queued_reports` | uint32 | 尚未交付的普通输入报告数量 |
| `pending_reads` | uint32 | 当前等待输入的上层读取数量 |
| `received_reads` | uint64 | 收到的上层读取累计数量 |
| `completed_reads` | uint64 | 成功完成上层读取的累计数量 |
| `failed_reads` | uint64 | 以失败状态完成的上层读取累计数量 |
| `last_read_status` | fixed32 | 最近处理读取的 NTSTATUS |
| `last_report_id` | uint32 | 最近处理的报告 ID |
| `last_report_bytes` | uint32 | 对应报告长度 |
| `last_buffer_bytes` | uint32 | 对应上层接收缓冲区长度 |
| `hid_descriptor_requests` | uint64 | HID 设备描述信息查询累计次数 |
| `report_descriptor_requests` | uint64 | HID 报告格式查询累计次数 |
| `attributes_requests` | uint64 | 设备属性查询累计次数 |
| `pending_release_mask` | uint32 | 待交付释放报告位图：`0x02` 键盘，`0x04` Consumer，`0x08` 鼠标，可按位组合 |

查询结果是即时快照，不是应用层确认。`completed_reads` 增加表示完成了上层 HID 读取；不能证明前台程序执行了快捷键。释放报告不计入 `queued_reports`，应同时检查 `pending_release_mask`。系统取消读取等情况不一定计入完成计数，不能用累计值相减推导 `pending_reads`。BLE 入口查询的是配套输出设备状态。

## 4. 输入命令与按键编码

### 4.1 keysend

`KeySend.keys` 为 1..32 个 `Key`；每个 Key 包含 `usage_page`（uint32）、`usage`（uint32）、可选的 `report_id`（uint32）。这些值表示 **HID Usage，不是 Windows VK、扫描码或 Unicode 字符**。

| action | 数值 | 行为 |
| --- | --- | --- |
| DOWN | 1 | 按住所列键，保留其他已按住的键 |
| UP | 2 | 释放所列键，保留其他已按住的键 |
| TAP | 3 | 提交一次按下与释放，保留组合之外的已有状态；所有所列键必须事先处于抬起状态 |

`ACTION_UNSPECIFIED=0` 无效。重复 DOWN 或重复 UP 幂等，不会额外触发一次点击。同一命令不能重复列出相同的页和 Usage。任一成员无效，整个组合被拒绝。

一个命令可以跨键盘、Consumer、鼠标按钮类型；整体校验和接受，但不同类型在 Windows 中不保证同时生效。TAP 不包含按住时长；需要长按时分别发送 DOWN 和 UP，并由客户端安排间隔。NKRO 支持多键状态，但每次 `keysend` 仍最多 32 个键。

输入缓存容量按报告计算。例如单个键盘组合 TAP 需要 2 条报告；同时包含三种类型的 TAP 最多需要 6 条。容量不足时整个命令拒绝，不会部分接受或覆盖旧输入。

### 4.2 键盘页 0x07，report_id=1

支持普通键 Usage `0x04..0xA4`、`0xB0..0xDD`，以及修饰键 `0xE0..0xE7`；不支持 `0xA5..0xAF` 等保留项和错误 Usage。

| Usage（十六进制） | 含义 |
| --- | --- |
| `04` / `05` / `06` | A / B / C |
| `1E` / `27` | 数字 1 / 0 |
| `28` / `29` / `2A` / `2B` / `2C` | Enter / Esc / Backspace / Tab / Space |
| `3A..45` | F1..F12 |
| `4F` / `50` / `51` / `52` | 右 / 左 / 下 / 上方向键 |
| `E0` / `E1` / `E2` / `E3` | 左 Ctrl / Shift / Alt / GUI（Windows 键） |
| `E4` / `E5` / `E6` / `E7` | 右 Ctrl / Shift / Alt / GUI（Windows 键） |

以上是常用示例；字母键名称表示 HID 键位，实际字符仍由系统布局与修饰键决定。

### 4.3 Consumer 页 0x0C，report_id=2

以下是支持的完整 20 项列表。“位号”用于第 6 节的输出位图。

| 位号 | Usage（十六进制） | 功能 |
| --- | --- | --- |
| 0 | `00B0` | 播放 |
| 1 | `00B1` | 暂停 |
| 2 | `00B7` | 停止播放 |
| 3 | `00CD` | 播放 / 暂停 |
| 4 | `00E9` | 音量增加 |
| 5 | `00EA` | 音量减少 |
| 6 | `00E2` | 静音 |
| 7 | `00B5` | 下一曲 |
| 8 | `00B6` | 上一曲 |
| 9 | `0183` | 媒体选择 / 启动媒体应用 |
| 10 | `018A` | 启动邮件应用 |
| 11 | `0192` | 启动计算器 |
| 12 | `0194` | 启动文件浏览器 |
| 13 | `0221` | 搜索 |
| 14 | `0223` | 浏览器主页 |
| 15 | `0224` | 浏览器后退 |
| 16 | `0225` | 浏览器前进 |
| 17 | `0226` | 浏览器停止 |
| 18 | `0227` | 浏览器刷新 |
| 19 | `022A` | 浏览器收藏夹 |

### 4.4 鼠标按钮与 mouse_move

鼠标按钮使用 `keysend`：页 `0x09`，Usage `1` / `2` / `3` 分别表示左 / 右 / 中键，`report_id=3`。

`MouseMove` 的 `x`、`y`、`wheel`、`pan` 均为 `sint32`，每项有效范围为 `-127..127`。未填写为 0，全部为 0 时成功但不产生移动报告。

| 字段 | 正数 | 负数 |
| --- | --- | --- |
| `x` | 向右移动 | 向左移动 |
| `y` | 向下移动 | 向上移动 |
| `wheel` | 向上滚动 | 向下滚动 |
| `pan` | 向右滚动 | 向左滚动 |

移动量是相对输入单位，不是屏幕绝对坐标，也不保证等于像素数；系统指针速度、加速和应用滚动设置会影响效果。超范围会拒绝，不会截断；较大移动应拆分成多次命令。移动时保留当前鼠标按钮状态。

拖动流程：左键 DOWN → 一次或多次 `mouse_move` → 左键 UP。每步检查回执。`reset_input` 为无字段消息，用于丢弃未交付输入并优先安排相关类型的全释放报告。

## 5. Windows 输出报告格式

本节用于客户分析 Windows 侧的统一输出数据。**管道输入仍应发送第 5 节的语义命令，不能把这些字节直接写入管道；物理报告也不保证采用此格式。** 下列偏移从 0 开始，长度均包含 Report ID。

### 5.1 键盘：30 字节

| 字节偏移 | 内容 |
| --- | --- |
| 0 | `01`：Report ID |
| 1 | 修饰键位图，bit 0..7 分别对应 Usage E0..E7 |
| 2..29 | 普通键位图；Usage U 对应位号 `U-0x04` |

普通键的字节偏移为 `2 + floor((U-0x04)/8)`，位掩码为 `1 << ((U-0x04) % 8)`。位为 1 表示按住，0 表示抬起。保留 Usage 位为 0；最后一个字节的 bit 2..7 为填充位，必须为 0。

例如只按住左 Ctrl+A：前 3 字节为 `01 01 01`，其后 27 字节为 0。全部释放时 ID 仍为 `01`，后续 29 字节为 0。

### 5.2 Consumer：4 字节

字节 0 为 `02`；字节 1、2、3 依次存放位号 0..7、8..15、16..19，字节 3 高四位为 0。位号与第 5.3 节一致，1 表示按住。

例如音量增加按下为 `02 10 00 00`，释放为 `02 00 00 00`。

### 5.3 鼠标：6 字节

| 字节偏移 | 内容 |
| --- | --- |
| 0 | `03`：Report ID |
| 1 | bit 0 左键、bit 1 右键、bit 2 中键；高五位为 0 |
| 2 | X 相对增量，有符号 8 位 |
| 3 | Y 相对增量，有符号 8 位 |
| 4 | 垂直滚轮，有符号 8 位 |
| 5 | 水平滚动，有符号 8 位 |

相对量采用 8 位补码，有效值 `-127..127`，不使用 `-128`。例如按住左键并向右移动 20、向上移动 5：`03 01 14 FB 00 00`；全部释放且不移动为 `03 00 00 00 00 00`。

## 6. 通信示例

以下为便于阅读的消息对象示意，数字使用十进制，**不是可直接发送的 JSON**。实际发送须使用 protobuf 序列化，再添加 4 字节长度头。每个示例请求需等待相应回执；主动报告可能穿插出现。

```text
服务端 → 客户端
{ request_id: 0, hello: { protocol_version: 2, max_payload_bytes: 66048 } }

客户端 → 服务端：查询基础信息
{ request_id: 1, query_basic_info: {} }

服务端 → 客户端：基础信息，核对身份和能力后继续
{ request_id: 1, basic_info: { ... } }

客户端 → 服务端：点击左 Ctrl+A
{ request_id: 2, keysend: {
    keys: [{ usage_page: 7, usage: 224 }, { usage_page: 7, usage: 4 }],
    action: 3
} }

服务端 → 客户端：已接受
{ request_id: 2, input_result: { ntstatus: 0 } }

客户端 → 服务端：音量增加一次
{ request_id: 3, keysend: {
    keys: [{ usage_page: 12, usage: 233 }], action: 3
} }

客户端 → 服务端：向右移动 20，同时向上滚动一格
{ request_id: 4, mouse_move: { x: 20, wheel: 1 } }

客户端 → 服务端：查询交付状态
{ request_id: 5, query_input_status: {} }

客户端 → 服务端：全部释放并清除积压
{ request_id: 6, reset_input: {} }
```

`request_id=1` 的 `query_basic_info` 可以编码为下面的完整帧，适合核对长度头与 protobuf 编码：

```text
04 00 00 00  08 01 52 00
-----------  -----------
载荷长度 4   ClientMessage 载荷
```

`request_id=2` 的 Ctrl+A TAP 完整帧示例（省略两个键的 `report_id`）：

```text
13 00 00 00  08 02 62 0F 0A 05 08 07 10 E0 01 0A 04 08 07 10 04 10 03
```

这里 `0x13=19` 为载荷长度；修改请求 ID 或参数后，必须重新序列化并重新计算长度。

## 7. 物理设备写入（0.9.1.0）

`physical_write` 发给所选物理源，和发往 Windows 的 `keysend` / `mouse_move` 不同。完成握手并检查 `supports_physical_write=true` 后使用；ROOT 独立输出设备没有物理写端点。

| PhysicalWrite 字段 | 类型 | 含义 |
| --- | --- | --- |
| `operation` | enum | WRITE_OUTPUT=1、SET_OUTPUT=2、SET_FEATURE=3；0 或其他值无效 |
| `data` | bytes | 完整 HID 客户端报告；首字节为物理 Report ID，无编号必须放 00；总长度 2～4096 |

Write Output 用于发送输出报告；Set Output 用于设置输出报告状态；Set Feature 用于设置特征报告。不要自动在三种方式之间重试或切换，按设备协议选择。字段中的 `bytes` 是二进制数据，不是十六进制文本；protobuf JSON 表示时使用 Base64。

普通 `HID\...` 集合的长度必须精确等于 `physical_output_report_bytes` 或 `physical_feature_report_bytes`，包含 ID 槽位；0 表示该集合没有对应报告。BLE 服务入口的这两个字段为 0，实际格式和长度由设备协议决定。驱动不补齐、不截断、不猜测语音控制命令，也不把 HID 数据直接写到独立的 FF05 等 GATT 服务。

Python protobuf 构造示例（`confirmed_report_bytes` 由设备协议提供，含 ID 槽位；仍需按第 3 节封帧发送）：

```python
request = keyboard_pb2.ClientMessage(request_id=next_request_id)
request.physical_write.operation = keyboard_pb2.PhysicalWrite.WRITE_OUTPUT
request.physical_write.data = confirmed_report_bytes
payload = request.SerializeToString()
frame = struct.pack("<I", len(payload)) + payload
```

回执为 `physical_write_result`，外层 `request_id` 与请求一致：

| PhysicalWriteResult 字段 | 类型 | 含义 |
| --- | --- | --- |
| `ntstatus` | fixed32 | 下层传输完成状态，0 为成功；不是客户端 FIFO 接受状态 |
| `bytes_transferred` | uint64 | 下层报告的传输数量，SET 操作可能为 0；BLE 无编号路径不含移除的 00 槽位 |

成功不保证设备业务已经执行；需要设备回复的协议，继续从 `physical_report` 接收并自行关联响应。未握手返回 `0xC0000184`（INVALID_DEVICE_STATE）；无物理端点或无对应集合报告返回 `0xC00000BB`（NOT_SUPPORTED）；非法操作返回 `0xC000000D`（INVALID_PARAMETER）；非法长度返回 `0xC0000206`（INVALID_BUFFER_SIZE）。下层错误不改写为成功。

驱动等待写完成 3 秒后发起取消，回执为 `0xC00000B5`（IO_TIMEOUT）；停止时取消写，状态为 `0xC0000120`（CANCELLED）。取消必须等待下层排空，因此 3 秒不是强制返回上限。未收到回执、超时或断线都不能证明设备未执行，驱动和测试客户端不自动重发。断线不会自动发送设备停止命令；`reset_input` 仅释放 Windows 合成输入。

物理读取仍在后台运行，但等待写完成期间 Pipe 暂停推送报告；长时间写入可能使 64 项输入队列覆盖旧报告，应检查 `queue_overwritten`。原始输入和写回执共用同一连接，客户端必须按消息类型分发。

## 8. 断开、重连与常见问题

正常退出前发送 `reset_input` 并处理回执，再关闭连接。管道断开、客户端崩溃或协议错误时，驱动会清除待交付输入并安排释放；释放仍依赖 Windows 继续读取，设备移除后不能保证继续交付。

保持连接但停止发送命令不会自动抬起已按住的键，因此长按操作必须配对 UP 或显式复位。断线重连后重新执行 Hello 和基础信息查询，重新建立本地按键状态；不要重放旧会话中未确认的命令。未收到回执不代表命令未执行，尤其不要盲目重发 TAP、移动或滚动。

| 现象 | 检查与处理 |
| --- | --- |
| 找不到管道 | 确认目标设备已安装并启动、实例 ID 正确；设备重启或重新枚举后刷新列表 |
| 管道忙（Win32 231） | 关闭占用同一设备的测试工具或其他客户端，再重试 |
| 连接后立即断开 | 检查帧长度、protobuf 定义、协议版本、严格递增的请求 ID，以及是否持续读取 |
| 没有物理报告 | 确认已完成基础信息查询、设备在线且确实产生输入；只有 Output/Feature 的集合不会提供输入数据 |
| 收到物理报告但没有 Windows 按键 | 客户端需要解析并发送 keysend；驱动不自动回注 |
| 命令成功但应用无反应 | 确认焦点和 Usage；查询交付状态，检查输出键盘/鼠标设备是否正常；BLE 检查配套独立输出设备 |
| `queued_reports` 持续大于 0，完成数不增加 | 检查 `active`、`pending_reads` 和 Windows 输出设备状态；管道连接成功本身不证明输出可用 |
| 输入忙或物理序号跳跃 | 两者不同：输入忙会拒绝新命令；物理缓存满会覆盖旧报告。持续收取消息并调整客户端处理速度 |
| TAP 返回无效状态 | 组合中已有键按住；先释放，或只 TAP 尚未按住的键 |

向技术支持反馈时，提供驱动版本、设备实例 ID、Hello / BasicInfo、失败命令及请求 ID、状态码和输入状态快照；涉及物理数据解析时附上该设备的报告格式说明及必要的原始报告样本。

本手册只适用于 **QuarborUniversalKeyboardDriver**。仓库中其他 HID Filter 驱动使用各自的接口，不能混用其协议和工具。
