#pragma once
#include <stdint.h>
#include <stddef.h>

// 以下类型仅在进程内使用，禁止直接发送结构体内存或依赖 sizeof。
// 线上协议由 shared/proto/hid_user.proto 定义，统一通过 Codec 编解码。
namespace quarbor { namespace hid_user {
constexpr wchar_t PipePrefix[] = L"Quarbor.HidUserFilter.v3.";
constexpr uint16_t Hello = 1, Report = 2, Status = 3;
constexpr uint16_t InjectReport = 4, InjectResult = 5, Capabilities = 6, ResetInput = 7, InjectKey = 8;
constexpr uint16_t QueryInputDiagnostics = 9, InputDiagnostics = 10;
constexpr uint8_t KeyDown = 1, KeyUp = 2;
constexpr uint16_t AnyReportId = 0xFFFF;
constexpr uint32_t MaxPayload = 4096;
constexpr uint32_t RingCapacity = 64;
constexpr uint32_t MaxMessageBytes = 8192; // Protobuf envelope + HID bytes; bounded future fields.
constexpr uint32_t FramePrefixBytes = 4;
constexpr uint32_t MaxFrameBytes = FramePrefixBytes + MaxMessageBytes;
constexpr uint32_t FrameTimeoutMs = 1000;

// optional 字段只保存一份存在位；值为零并不表示字段缺省。
enum ReadDetailsField : uint8_t {
    RequestedBytesPresent = 1,
    BufferBytesPresent = 2,
    EffectiveIoTypePresent = 4,
    RequestorModePresent = 8,
    AllReadDetails = RequestedBytesPresent | BufferBytesPresent | EffectiveIoTypePresent | RequestorModePresent
};

// 通用元数据：物理报告序号与命令 requestId 相互独立。
struct Header {
    uint16_t type;
    uint32_t payloadBytes;   // Raw HID bytes only; no encoded structure sizes.
    uint64_t reportSequence; // Physical report count, independent of command IDs.
    uint64_t timestamp;      // UTC FILETIME, 100 ns units.
    uint64_t dropped;        // Reports discarded before/during delivery (see README).
    uint32_t status;         // Last lower-read NTSTATUS; zero means success.
    uint64_t requestId;      // Client commands and correlated responses only.
};
struct InputCapabilities {
    uint32_t inputReportBytes; // HIDP_CAPS length, including the Report ID slot (zero for unnumbered reports).
    uint32_t queueCapacity;
    uint32_t flags;            // bit 0: nonzero IDs; bit 1: key injection; bit 2: READ diagnostics.
    uint8_t reportIds[32];     // Bit i: input report ID i can be injected. Empty = unsupported.
};
struct InjectKeyCommand {
    uint16_t usagePage;
    uint16_t usage;
    uint8_t action;
    uint16_t reportId;       // AnyReportId selects a unique matching input report.
};
inline bool ValidKeyCommand(const InjectKeyCommand& command) {
    return (command.action == KeyDown || command.action == KeyUp) &&
        (command.reportId == AnyReportId || command.reportId <= 0xFF);
}
constexpr uint32_t InputHasReportId = 1;
constexpr uint32_t InputKeyInjection = 2;
constexpr uint32_t InputReadDiagnostics = 4;
struct InputDiagnosticsData {
    uint64_t acceptedReports;
    uint64_t completedReads;
    uint64_t failedReads;
    uint32_t queuedReports;
    uint32_t queuedReads;
    uint32_t ownedReads;
    uint32_t queueState;
    uint32_t lastReadStatus;
    uint32_t lastReadBytes;
    uint32_t inputReportBytes;
    uint32_t lastReportId;
    uint8_t lastEncodedReport[32]; // Prefix of most recently accepted report, including Report ID slot.
    uint32_t requestedBytes;
    uint32_t bufferBytes;
    uint32_t effectiveIoType;      // WDF_DEVICE_IO_TYPE: 2 buffered, 3 direct; 0 before first READ.
    uint32_t requestorMode;        // KPROCESSOR_MODE: 0 kernel, 1 user; UINT32_MAX before first READ.
};
struct Packet {
    Header header{};
    uint8_t payload[MaxPayload]{};
    wchar_t instanceId[512]{}; // Local UTF-16 DTO, wire string is UTF-8.
    InputCapabilities capabilities{};
    InjectKeyCommand key{};
    InputDiagnosticsData diagnostics{};
    uint8_t readDetailsFields = 0;
    bool HasReadDetails() const { return (readDetailsFields & AllReadDetails) == AllReadDetails; }
};
} }
