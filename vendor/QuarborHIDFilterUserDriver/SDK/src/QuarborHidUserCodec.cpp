#include "QuarborHidUserMemory.h"
#include <string.h>
#include "QuarborHidUserCodec.h"
#include "hid_user.pb.h"
#include "pb_encode.h"
#include "pb_decode.h"

// 协议的内存上界依赖静态字段；禁止构建配置悄悄启用动态解码分配。
#ifdef PB_ENABLE_MALLOC
#error HID protocol must use bounded static nanopb storage
#endif

namespace quarbor { namespace hid_user {
static_assert(quarbor_hid_v3_ClientMessage_size <= MaxMessageBytes, "client frame bound");
static_assert(quarbor_hid_v3_ServerMessage_size <= MaxMessageBytes, "server frame bound");
namespace {
// 帧处理只负责长度和 Protobuf，不执行任何输入操作。
bool Encode(const pb_msgdesc_t* fields, const void* message, uint8_t* frame, size_t capacity, size_t& length) {
    length = 0;
    if (!frame || capacity <= FramePrefixBytes) return false;
    const size_t available = capacity - FramePrefixBytes;
    pb_ostream_t out = pb_ostream_from_buffer(frame + FramePrefixBytes,
        available < MaxMessageBytes ? available : MaxMessageBytes);
    if (!pb_encode(&out, fields, message) || !out.bytes_written) return false;
    const auto size = static_cast<uint32_t>(out.bytes_written);
    for (unsigned i = 0; i < FramePrefixBytes; ++i) frame[i] = static_cast<uint8_t>(size >> (8 * i));
    length = FramePrefixBytes + size;
    return true;
}
bool Decode(const pb_msgdesc_t* fields, void* message, const uint8_t* bytes, size_t length) {
    if (!bytes || !length || length > MaxMessageBytes) return false;
    pb_istream_t in = pb_istream_from_buffer(bytes, length);
    return pb_decode(&in, fields, message) && in.bytes_left == 0;
}
// 诊断字段集中映射，消息分发处只处理类型和方向。
void EncodeDiagnostics(const Packet& packet, quarbor_hid_v3_Diagnostics& message) {
    const auto& data = packet.diagnostics;
    message.accepted_reports = data.acceptedReports;
    message.completed_reads = data.completedReads;
    message.failed_reads = data.failedReads;
    message.queued_reports = data.queuedReports;
    message.queued_reads = data.queuedReads;
    message.owned_reads = data.ownedReads;
    message.queue_state = data.queueState;
    message.last_read_status = data.lastReadStatus;
    message.last_read_bytes = data.lastReadBytes;
    message.input_report_bytes = data.inputReportBytes;
    message.last_report_id = data.lastReportId;
    message.last_encoded_report.size = sizeof(data.lastEncodedReport);
    memcpy(message.last_encoded_report.bytes, data.lastEncodedReport, sizeof(data.lastEncodedReport));
    message.has_requested_bytes = (packet.readDetailsFields & RequestedBytesPresent) != 0;
    message.requested_bytes = data.requestedBytes;
    message.has_buffer_bytes = (packet.readDetailsFields & BufferBytesPresent) != 0;
    message.buffer_bytes = data.bufferBytes;
    message.has_effective_io_type = (packet.readDetailsFields & EffectiveIoTypePresent) != 0;
    message.effective_io_type = data.effectiveIoType;
    message.has_requestor_mode = (packet.readDetailsFields & RequestorModePresent) != 0;
    message.requestor_mode = data.requestorMode;
}
bool DecodeDiagnostics(const quarbor_hid_v3_Diagnostics& message, Packet& packet) {
    auto& data = packet.diagnostics;
    if (message.last_encoded_report.size != sizeof(data.lastEncodedReport)) return false;
    data.acceptedReports = message.accepted_reports;
    data.completedReads = message.completed_reads;
    data.failedReads = message.failed_reads;
    data.queuedReports = message.queued_reports;
    data.queuedReads = message.queued_reads;
    data.ownedReads = message.owned_reads;
    data.queueState = message.queue_state;
    data.lastReadStatus = message.last_read_status;
    data.lastReadBytes = message.last_read_bytes;
    data.inputReportBytes = message.input_report_bytes;
    data.lastReportId = message.last_report_id;
    memcpy(data.lastEncodedReport, message.last_encoded_report.bytes, sizeof(data.lastEncodedReport));
    if (message.has_requested_bytes) packet.readDetailsFields |= RequestedBytesPresent;
    data.requestedBytes = message.requested_bytes;
    if (message.has_buffer_bytes) packet.readDetailsFields |= BufferBytesPresent;
    data.bufferBytes = message.buffer_bytes;
    if (message.has_effective_io_type) packet.readDetailsFields |= EffectiveIoTypePresent;
    data.effectiveIoType = message.effective_io_type;
    if (message.has_requestor_mode) packet.readDetailsFields |= RequestorModePresent;
    data.requestorMode = message.has_requestor_mode ? message.requestor_mode : UINT32_MAX;
    return true;
}
}
uint32_t ReadFrameLength(const uint8_t* prefix) {
    return uint32_t(prefix[0]) | (uint32_t(prefix[1]) << 8) |
        (uint32_t(prefix[2]) << 16) | (uint32_t(prefix[3]) << 24);
}
bool EncodeClientFrame(const Packet& packet, uint8_t* frame, size_t capacity, size_t& length) {
    length = 0;
    if (!packet.header.requestId) return false;
    Wiped<quarbor_hid_v3_ClientMessage> storage;
    auto& message = storage.value;
    message.request_id = packet.header.requestId;
    switch (packet.header.type) {
    case InjectReport:
        if (!packet.header.payloadBytes || packet.header.payloadBytes > MaxPayload) return false;
        message.which_body = quarbor_hid_v3_ClientMessage_inject_report_tag;
        message.body.inject_report.report.size = static_cast<pb_size_t>(packet.header.payloadBytes);
        memcpy(message.body.inject_report.report.bytes, packet.payload, packet.header.payloadBytes);
        break;
    case InjectKey:
        if (!ValidKeyCommand(packet.key)) return false;
        message.which_body = quarbor_hid_v3_ClientMessage_inject_key_tag;
        message.body.inject_key.usage_page = packet.key.usagePage;
        message.body.inject_key.usage = packet.key.usage;
        message.body.inject_key.action = static_cast<quarbor_hid_v3_InjectKey_Action>(packet.key.action);
        message.body.inject_key.has_report_id = packet.key.reportId != AnyReportId;
        message.body.inject_key.report_id = message.body.inject_key.has_report_id ? packet.key.reportId : 0;
        break;
    case ResetInput: message.which_body = quarbor_hid_v3_ClientMessage_reset_input_tag; break;
    case QueryInputDiagnostics: message.which_body = quarbor_hid_v3_ClientMessage_query_diagnostics_tag; break;
    default: return false;
    }
    return Encode(quarbor_hid_v3_ClientMessage_fields, &message, frame, capacity, length);
}
bool DecodeClientMessage(const uint8_t* bytes, size_t length, Packet& packet) {
    Wiped<quarbor_hid_v3_ClientMessage> storage;
    auto& message = storage.value;
    if (!Decode(quarbor_hid_v3_ClientMessage_fields, &message, bytes, length) || !message.request_id) return false;
    Wiped<Packet> decoded;
    auto& result = decoded.value;
    result.header.requestId = message.request_id;
    switch (message.which_body) {
    case quarbor_hid_v3_ClientMessage_inject_report_tag:
        result.header.type = InjectReport;
        result.header.payloadBytes = message.body.inject_report.report.size;
        if (!result.header.payloadBytes || result.header.payloadBytes > MaxPayload) return false;
        memcpy(result.payload, message.body.inject_report.report.bytes, result.header.payloadBytes);
        break;
    case quarbor_hid_v3_ClientMessage_inject_key_tag: {
        const auto& key = message.body.inject_key;
        if (key.usage_page > UINT16_MAX || key.usage > UINT16_MAX ||
            (key.has_report_id && key.report_id > UINT8_MAX) || (key.action != KeyDown && key.action != KeyUp)) return false;
        result.header.type = InjectKey;
        result.key = {static_cast<uint16_t>(key.usage_page), static_cast<uint16_t>(key.usage),
            static_cast<uint8_t>(key.action), key.has_report_id ? static_cast<uint16_t>(key.report_id) : AnyReportId};
        break;
    }
    case quarbor_hid_v3_ClientMessage_reset_input_tag: result.header.type = ResetInput; break;
    case quarbor_hid_v3_ClientMessage_query_diagnostics_tag: result.header.type = QueryInputDiagnostics; break;
    default: return false; // 拒绝缺失/未知命令，以及反射回来的服务端消息。
    }
    packet = result;
    return true;
}
bool EncodeServerFrame(const Packet& packet, uint8_t* frame, size_t capacity, size_t& length) {
    length = 0;
    Wiped<quarbor_hid_v3_ServerMessage> storage;
    auto& message = storage.value;
    const auto& h = packet.header;
    const bool response = h.type == InjectResult || h.type == InputDiagnostics;
    if (response != (h.requestId != 0)) return false;
    message.request_id = h.requestId;
    message.timestamp_filetime = h.timestamp;
    message.report_sequence = h.reportSequence;
    message.dropped = h.dropped;
    message.ntstatus = h.status;
    switch (h.type) {
    case Hello: {
        size_t chars = 0;
        while (chars < ARRAYSIZE(packet.instanceId) && packet.instanceId[chars]) ++chars;
        if (!chars || chars >= ARRAYSIZE(packet.instanceId)) return false;
        auto& id = message.body.hello.instance_id;
        const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, packet.instanceId,
            static_cast<int>(chars), reinterpret_cast<char*>(id.bytes), sizeof(id.bytes), nullptr, nullptr);
        if (!count) return false;
        id.size = static_cast<pb_size_t>(count);
        message.which_body = quarbor_hid_v3_ServerMessage_hello_tag;
        break;
    }
    case Report:
        if (!h.payloadBytes || h.payloadBytes > MaxPayload || h.status) return false;
        message.which_body = quarbor_hid_v3_ServerMessage_report_tag;
        message.body.report.report.size = static_cast<pb_size_t>(h.payloadBytes);
        memcpy(message.body.report.report.bytes, packet.payload, h.payloadBytes);
        break;
    case Status: message.which_body = quarbor_hid_v3_ServerMessage_status_tag; break;
    case Capabilities: {
        message.which_body = quarbor_hid_v3_ServerMessage_capabilities_tag;
        auto& caps = message.body.capabilities;
        caps.input_report_bytes = packet.capabilities.inputReportBytes;
        caps.queue_capacity = packet.capabilities.queueCapacity;
        caps.flags = packet.capabilities.flags;
        caps.report_ids.size = 32;
        memcpy(caps.report_ids.bytes, packet.capabilities.reportIds, 32);
        break;
    }
    case InjectResult: message.which_body = quarbor_hid_v3_ServerMessage_result_tag; break;
    case InputDiagnostics:
        message.which_body = quarbor_hid_v3_ServerMessage_diagnostics_tag;
        EncodeDiagnostics(packet, message.body.diagnostics);
        break;
    default: return false;
    }
    return Encode(quarbor_hid_v3_ServerMessage_fields, &message, frame, capacity, length);
}
bool DecodeServerMessage(const uint8_t* bytes, size_t length, Packet& packet) {
    Wiped<quarbor_hid_v3_ServerMessage> storage;
    auto& message = storage.value;
    if (!Decode(quarbor_hid_v3_ServerMessage_fields, &message, bytes, length)) return false;
    Wiped<Packet> decoded;
    auto& result = decoded.value;
    result.header = {0, 0, message.report_sequence, message.timestamp_filetime, message.dropped, message.ntstatus, message.request_id};
    switch (message.which_body) {
    case quarbor_hid_v3_ServerMessage_hello_tag: {
        const auto& id = message.body.hello.instance_id;
        if (!id.size || memchr(id.bytes, 0, id.size)) return false;
        const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
            reinterpret_cast<const char*>(id.bytes), id.size, result.instanceId, ARRAYSIZE(result.instanceId) - 1);
        if (!count) return false;
        result.instanceId[count] = 0;
        result.header.type = Hello;
        break;
    }
    case quarbor_hid_v3_ServerMessage_report_tag:
        result.header.type = Report;
        result.header.payloadBytes = message.body.report.report.size;
        if (!result.header.payloadBytes || result.header.payloadBytes > MaxPayload || result.header.status) return false;
        memcpy(result.payload, message.body.report.report.bytes, result.header.payloadBytes);
        break;
    case quarbor_hid_v3_ServerMessage_status_tag: result.header.type = Status; break;
    case quarbor_hid_v3_ServerMessage_capabilities_tag: {
        const auto& caps = message.body.capabilities;
        if (caps.report_ids.size != 32 || !caps.input_report_bytes || caps.input_report_bytes > UINT16_MAX ||
            caps.queue_capacity != RingCapacity) return false;
        result.header.type = Capabilities;
        result.capabilities = {caps.input_report_bytes, caps.queue_capacity, caps.flags, {}};
        memcpy(result.capabilities.reportIds, caps.report_ids.bytes, 32);
        break;
    }
    case quarbor_hid_v3_ServerMessage_result_tag: result.header.type = InjectResult; break;
    case quarbor_hid_v3_ServerMessage_diagnostics_tag:
        result.header.type = InputDiagnostics;
        if (!DecodeDiagnostics(message.body.diagnostics, result)) return false;
        break;
    default: return false;
    }
    const bool response = result.header.type == InjectResult || result.header.type == InputDiagnostics;
    if (response != (result.header.requestId != 0)) return false;
    packet = result;
    return true;
}
} }
