# Quarbor 虚拟麦克风通信用户手册

## 1. 通信入口

驱动提供三个通信操作：查询状态、发送 PCM 音频、清空待处理音频。

| 项目 | 内容 |
| --- | --- |
| 设备路径 | `\\.\QuarborVirtualMicrophone` |
| 当前通信协议版本 | `1` |
| 调用方式 | C++ 客户端接口，或 Windows `DeviceIoControl` |
| 协议声明 | `vmic_protocol.h` |
| C++ 客户端声明 | `QuarborVirtualMicrophoneDriver.h` |
| 通信权限 | 默认允许普通本地用户读写；仅查询状态时可使用只读权限 |

使用前须已安装驱动，并能在 Windows 录音设备中找到 Quarbor 虚拟麦克风。

## 2. 调用顺序

1. 打开控制设备连接。
2. 调用状态查询，检查 `ProtocolVersion` 是否为 `1`。
3. 让接收程序选择 Quarbor 虚拟麦克风并开始录音。也可以由发送程序通过 Windows 音频接口启动该设备的录音。
4. 等待状态满足 `CaptureActive == 1` 且 `CaptureState == QuarborVmicStateRunning`。
5. 按状态中 `Format` 指定的格式准备 PCM 数据；需要丢弃旧音频时先清空。
6. 按音频时长分块发送，持续检查状态和剩余空间。
7. 结束会话时停止发送，并关闭控制连接。

打开控制设备不会自动开始录音。状态查询成功，也不代表当前可以发送音频。

需要完整发送最后一段音频时，应等待接收程序完成读取后再关闭连接。需要立即丢弃尚未处理的音频时，先调用清空操作。

## 3. 使用 C++ 客户端

使用提供的 `QuarborVirtualMicrophoneClient`，调用前包含 `QuarborVirtualMicrophoneDriver.h`。在应用工程中加入配套的 `QuarborVirtualMicrophoneDriver.cpp`，并保留其引用的 `vmic_protocol.h`。

### 接口

```cpp
bool Open(DWORD desiredAccess = GENERIC_READ | GENERIC_WRITE) noexcept;
void Close() noexcept;
bool IsOpen() const noexcept;

bool GetStatus(QUARBOR_VMIC_STATUS* status) noexcept;

bool WritePcm(
    const void* pcmData,
    ULONG pcmBytes,
    const QUARBOR_VMIC_FORMAT* format = nullptr,
    ULONG flags = 0,
    ULONG* acceptedBytes = nullptr) noexcept;

bool Flush() noexcept;
DWORD LastError() const noexcept;
HANDLE NativeHandle() const noexcept;
```

| 接口 | 使用说明 |
| --- | --- |
| `Open()` | 打开读写连接；仅查询时使用 `Open(GENERIC_READ)`。再次调用会先关闭原连接 |
| `GetStatus(&status)` | 查询状态；成功后检查结构大小、协议版本、录音状态和音频格式 |
| `WritePcm(...)` | 同步发送一个 PCM 数据块；`flags` 必须为 `0` |
| `Flush()` | 清空尚未处理的音频，需要可写连接及已建立的录音流 |
| `Close()` | 关闭连接；客户端对象销毁时也会关闭连接 |
| `IsOpen()` | 判断客户端是否持有句柄；设备被移除后仍可能返回 `true`，须结合实际调用结果判断连接是否有效 |
| `LastError()` | 获取最近一次调用记录的 Win32 错误码；调用失败后立即读取 |
| `NativeHandle()` | 获取当前句柄供直接调用；由客户端管理其关闭，不要另外对它调用 `CloseHandle` |

`Open`、`GetStatus`、`WritePcm`、`Flush` 返回 `true` 表示本次调用成功，返回 `false` 时读取 `LastError()`。

同一个客户端对象的连接、发送、查询和关闭操作应串行调用，避免发送期间由另一个线程关闭连接。

`WritePcm` 的 `acceptedBytes` 可不传。传入时，成功返回本次 `pcmBytes`，失败返回 `0`。写入成功不等于接收程序已经读到该段音频。

### 发送单个数据块

下面的函数接收一个已经打开的客户端，以及调用方准备好的 PCM 数据。客户端应在整个发送会话中保持打开，不要每发送一块就关闭。

```cpp
#include "QuarborVirtualMicrophoneDriver.h"

DWORD SendPcmBlock(
    QuarborVirtualMicrophoneClient& client,
    const void* pcmData,
    ULONG pcmBytes)
{
    QUARBOR_VMIC_STATUS status{};
    if (!client.GetStatus(&status))
        return client.LastError();

    if (status.Size < sizeof(status) ||
        status.ProtocolVersion != QUARBOR_VMIC_PROTOCOL_VERSION)
        return ERROR_REVISION_MISMATCH;

    if (!status.CaptureActive ||
        status.CaptureState != QuarborVmicStateRunning)
        return ERROR_NOT_READY;

    if (!client.WritePcm(pcmData, pcmBytes, &status.Format))
        return client.LastError();

    return ERROR_SUCCESS;
}
```

调用该函数前，先创建客户端并调用 `Open()`。传入的 PCM 数据必须已经符合 `GetStatus` 返回的格式；函数不会转换音频格式。持续发送时还应按第 6 节控制发送速度。

## 4. 直接调用 DeviceIoControl

### 打开连接

```cpp
#include <Windows.h>
#include "vmic_protocol.h"

HANDLE device = CreateFileW(
    QUARBOR_VMIC_WIN32_DEVICE_PATH,
    GENERIC_READ | GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    nullptr);
```

返回 `INVALID_HANDLE_VALUE` 时，立即调用 `GetLastError()`。仅查询状态时，可以把访问权限改成 `GENERIC_READ`。

以下参数按同步调用填写，`lpOverlapped` 为 `nullptr`。会话结束时对成功打开的句柄调用 `CloseHandle(device)`。

### 命令与参数

| 操作 | IOCTL | 数值 | 句柄权限 |
| --- | --- | --- | --- |
| 查询状态 | `IOCTL_VMIC_GET_STATUS` | `0x83376008` | 读 |
| 发送 PCM | `IOCTL_VMIC_WRITE_PCM` | `0x8337A005` | 写 |
| 清空音频 | `IOCTL_VMIC_FLUSH` | `0x8337A00C` | 写 |

| 参数 | 查询状态 | 发送 PCM | 清空音频 |
| --- | --- | --- | --- |
| `lpInBuffer` | `nullptr` | 指向 `QUARBOR_VMIC_WRITE_PCM_REQUEST` | `nullptr` |
| `nInBufferSize` | `0` | `sizeof(QUARBOR_VMIC_WRITE_PCM_REQUEST)` | `0` |
| `lpOutBuffer` | 指向 `QUARBOR_VMIC_STATUS` | **指向待发送的 PCM 数据** | `nullptr` |
| `nOutBufferSize` | `sizeof(QUARBOR_VMIC_STATUS)` | PCM 字节数，与请求的 `DataBytes` 一致 | `0` |
| `lpBytesReturned` | 指向有效的 `DWORD` 变量 | 指向有效的 `DWORD` 变量 | 指向有效的 `DWORD` 变量 |
| `lpOverlapped` | `nullptr` | `nullptr` | `nullptr` |

发送 PCM 时，音频数据放在 `lpOutBuffer`，请求结构放在 `lpInBuffer`。该调用读取音频数据，不向该音频缓冲区返回状态。

所有调用均以 `DeviceIoControl` 的返回值判断成功或失败，失败后立即读取 `GetLastError()`。

- 查询成功后，返回字节数应至少为 `sizeof(QUARBOR_VMIC_STATUS)`；同时检查返回的 `Size` 和 `ProtocolVersion`。
- 写入成功时，`lpBytesReturned` 对应的值为 `0`，不能把它当作音频接受字节数。
- 清空成功时，返回字节数为 `0`。
- 同步调用结束前，保持请求结构和 PCM 缓冲区有效，且不要修改正在发送的数据。

写入请求的填写方式：

```cpp
QUARBOR_VMIC_WRITE_PCM_REQUEST request{};
request.Size = sizeof(request);
request.ProtocolVersion = QUARBOR_VMIC_PROTOCOL_VERSION;
request.DataBytes = pcmBytes;
request.Format = status.Format;
request.Flags = 0;

DWORD bytesReturned = 0;
BOOL ok = DeviceIoControl(
    device,
    IOCTL_VMIC_WRITE_PCM,
    &request,
    sizeof(request),
    pcmData,
    pcmBytes,
    &bytesReturned,
    nullptr);
```

上例中，`status` 是已查询到的状态，`pcmData` 是指向有效 PCM 缓冲区的 `void*`，`pcmBytes` 是该数据块的字节数。

## 5. 通信数据结构

所有整数采用小端字节序。`ULONG` 为 32 位无符号整数，`USHORT` 为 16 位无符号整数，`LONG` 为 32 位有符号整数。跨语言调用时按下面的字段顺序和 4 字节结构对齐设置类型。

| 结构体 | 当前大小 |
| --- | --- |
| `QUARBOR_VMIC_FORMAT` | 8 字节 |
| `QUARBOR_VMIC_WRITE_PCM_REQUEST` | 24 字节 |
| `QUARBOR_VMIC_STATUS` | 84 字节 |

使用 C/C++ 时优先直接包含 `vmic_protocol.h`，并使用 `sizeof` 填写长度。

### 音频格式

```cpp
typedef struct _QUARBOR_VMIC_FORMAT {
    ULONG SampleRate;
    USHORT BitsPerSample;
    USHORT Channels;
} QUARBOR_VMIC_FORMAT;
```

| 字段 | 含义 |
| --- | --- |
| `SampleRate` | 每秒采样帧数，单位 Hz |
| `BitsPerSample` | 每个声道样本的位数：`16` 或 `24` |
| `Channels` | 声道数：`1` 或 `2` |

### 写入请求

```cpp
typedef struct _QUARBOR_VMIC_WRITE_PCM_REQUEST {
    ULONG Size;
    ULONG ProtocolVersion;
    ULONG DataBytes;
    QUARBOR_VMIC_FORMAT Format;
    ULONG Flags;
} QUARBOR_VMIC_WRITE_PCM_REQUEST;
```

| 字段 | 填写要求 |
| --- | --- |
| `Size` | `sizeof(QUARBOR_VMIC_WRITE_PCM_REQUEST)`，当前为 `24` |
| `ProtocolVersion` | `QUARBOR_VMIC_PROTOCOL_VERSION`，当前为 `1` |
| `DataBytes` | 本次发送的 PCM 字节数，须大于 `0`，不超过 `1,048,576`，并为完整音频帧的整数倍 |
| `Format` | 建议复制最新查询结果中的 `Format`；每个非零字段必须与当前录音格式一致 |
| `Flags` | 固定为 `0` |

`Format` 的字段可以填 `0`，表示沿用当前录音格式。使用客户端时传 `format=nullptr` 相当于三个字段全部填 `0`。即使填 `0`，输入数据仍必须符合当前录音格式。

### 状态结果

```cpp
typedef enum _QUARBOR_VMIC_CAPTURE_STATE {
    QuarborVmicStateStopped = 0,
    QuarborVmicStateAcquired = 1,
    QuarborVmicStatePaused = 2,
    QuarborVmicStateRunning = 3
} QUARBOR_VMIC_CAPTURE_STATE;

typedef struct _QUARBOR_VMIC_STATUS {
    ULONG Size;
    ULONG ProtocolVersion;
    USHORT DriverVersionMajor;
    USHORT DriverVersionMinor;
    USHORT DriverVersionBuild;
    USHORT DriverVersionRevision;
    ULONG CaptureActive;
    ULONG CaptureState;
    QUARBOR_VMIC_FORMAT Format;
    ULONG FrameBytes;
    ULONG FifoCapacityBytes;
    ULONG FifoQueuedBytes;
    ULONG FifoFreeBytes;
    ULONG FifoOverflowBytes;
    ULONG WaveRtBufferBytes;
    ULONG WaveRtBufferDurationMs;
    ULONG LastWriteBytes;
    LONG LastIoStatus;
    ULONG Reserved[4];
} QUARBOR_VMIC_STATUS;
```

| 字段 | 含义 |
| --- | --- |
| `Size` | 返回结构大小，当前为 `84` |
| `ProtocolVersion` | 通信协议版本，当前为 `1` |
| `DriverVersionMajor/Minor/Build/Revision` | 驱动版本的四个分段 |
| `CaptureActive` | `1` 表示录音流正在运行；`0` 表示未运行 |
| `CaptureState` | `0` 停止、`1` 已获取、`2` 暂停、`3` 运行 |
| `Format` | 当前录音流使用的 PCM 格式；未建立录音流时可能全为 `0` |
| `FrameBytes` | 一帧音频的字节数，等于 `Channels × BitsPerSample ÷ 8` |
| `FifoCapacityBytes` | 可排队音频的总容量，单位字节 |
| `FifoQueuedBytes` | 当前排队等待处理的音频字节数 |
| `FifoFreeBytes` | 当前剩余空间，单位字节 |
| `FifoOverflowBytes` | 因空间不足累计丢弃的音频字节数，最大显示 `2,147,483,647`；清空操作不重置此计数，重新建立录音流时重新计数 |
| `WaveRtBufferBytes` | 当前录音缓冲区大小，单位字节 |
| `WaveRtBufferDurationMs` | 当前录音缓冲区时长，单位毫秒 |
| `LastWriteBytes` | 最近记录的写入所接受的字节数；清空后为 `0` |
| `LastIoStatus` | 最近记录的操作状态，类型为 NTSTATUS；`0` 表示成功，不是 `GetLastError()` 使用的 Win32 错误码 |
| `Reserved` | 保留字段，读取时忽略 |

没有录音流时，状态查询仍可成功，`CaptureActive` 为 `0`，`LastIoStatus` 可表示设备尚未就绪。请以每次调用的返回值和对应错误码判断该次操作是否成功，不要用 `LastIoStatus` 代替单次调用结果。

## 6. PCM 格式与连续发送

| 项目 | 支持范围 |
| --- | --- |
| 采样率 | `8000`、`16000`、`24000`、`32000`、`44100`、`48000`、`96000`、`192000` Hz |
| 样本格式 | 有符号整数 PCM16 或 PCM24，小端字节序 |
| 声道 | 单声道或双声道 |
| PCM24 存储 | 每声道每样本占 3 字节 |
| 双声道顺序 | 左、右声道交错排列：`L0, R0, L1, R1, ...` |
| 单次发送上限 | `1,048,576` 字节，同时必须满足整帧对齐 |

只发送原始 PCM 数据，不附带 WAV 文件头。MP3、AAC、浮点音频等数据应先转换为当前录音格式。

发送前以 `GetStatus` 返回的 `Format` 为准。写入请求中的格式字段不会改变设备格式。

字节数计算：

```text
每帧字节数 = 声道数 × 每样本位数 ÷ 8
数据块字节数 = 音频帧数 × 每帧字节数
数据块时长（秒） = 音频帧数 ÷ 采样率
```

例如，`48000 Hz / 16 位 / 双声道` 的每帧为 `4` 字节，`10 ms` 对应 `480` 帧，即 `1920` 字节。

连续发送时可按约 `10 ms` 分块，并根据 `FifoQueuedBytes` 和 `FifoFreeBytes` 调整发送节奏。空闲空间不足时先等待，再查询状态；避免无间隔地发送整段长音频。

空间不足时，较早的未处理音频会被丢弃，`FifoOverflowBytes` 增加，此时写入仍可能成功。没有可用音频时，录音端接收到静音。

同一时间建议由一个发送程序负责注入音频。多个连接共用同一待处理音频队列，清空操作会影响其他发送者。

## 7. 清空、断开与恢复

- 切换音源或需要立即丢弃旧音频时，在录音流已建立的情况下调用 `Flush()` 或 `IOCTL_VMIC_FLUSH`。
- 暂停或停止录音会清空此前尚未处理的音频。恢复录音后重新查询状态和格式，再继续发送。
- 关闭最后一个控制连接也会清空待处理音频；保持连接直到需要保留的音频已被接收程序读取。
- 遇到设备移除、卸载、音频连接失效或持续通信失败时，停止发送并及时关闭控制句柄。若同时持有录音连接，先关闭控制句柄，再停止和释放录音连接。
- 设备恢复或睡眠、休眠唤醒后，重新确认录音连接及设备状态。旧控制句柄失效时重新打开；等待录音状态为运行，并按最新格式恢复发送。

| 现象 | 处理方式 |
| --- | --- |
| 打开连接失败 | 确认驱动设备存在，检查访问权限，并记录 `LastError()` 或 `GetLastError()` |
| 状态查询成功，但录音未运行 | 让接收程序选择 Quarbor 虚拟麦克风并开始录音，然后重新查询 |
| 写入提示参数或长度错误 | 检查协议版本、`Flags=0`、格式匹配、数据长度上限和整帧对齐 |
| 清空失败，设备未就绪 | 确认录音流已建立；停止或移除设备后无需持续重试清空 |
| 写入成功但声音断续 | 检查数据格式和发送节奏，并观察排队量及溢出计数 |
| 设备移除后旧句柄持续失败 | 关闭旧连接，待设备恢复后重新打开 |
