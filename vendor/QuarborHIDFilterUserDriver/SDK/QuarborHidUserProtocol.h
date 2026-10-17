#pragma once
#include <stddef.h>
#include <stdint.h>

// Public byte-stream ABI for the user-mode HID report broker. All fields on
// the wire are fixed-width little-endian integers; no pointers or size_t.
namespace quarbor
{
namespace hid_user
{
// v2 is the only published channel.  Legacy v1 names and QHF1 frames are
// intentionally absent from this ABI and are rejected by the pipe server.
constexpr wchar_t PipePrefix[] = L"Quarbor.HidUserFilter.v2.";
constexpr uint32_t Magic = 0x32464851; // QHF2
constexpr uint16_t Version = 2;
constexpr uint32_t MaxPayload = 4096;
constexpr uint32_t MaxReport = MaxPayload;
constexpr uint32_t RingCapacity = 64;
constexpr uint32_t DefaultTimeoutMs = 100;

enum MessageType : uint16_t
{
    // Driver-to-client messages precede the two client-to-driver messages so
    // IsKnownType can perform a cheap range check before payload validation.
    Hello = 1,
    ClientHello = 2,
    ReportRequest = 3,
    ReportReply = 4,
    ReplyResult = 5,
    Status = 6,
    Report = ReportRequest,
};
enum ReplyResultCode : uint32_t
{
    ReplyAccepted = 0,
    ReplyExpired = 1,
    ReplyInvalid = 2,
    ReplyNoClient = 3,
    ReplyDisconnected = 4,
    ReplyCancelled = 5,
    ReplyOverflow = 6,
};
enum StatusFlags : uint32_t
{
    StatusConnected = 1u << 0,
    StatusHandshaken = 1u << 1,
    StatusHasPending = 1u << 2,
};

// 64-byte fixed header. Clients copy sessionId and sequence verbatim in replies.
struct Header
{
    uint32_t magic;        // 0
    uint16_t version;      // 4
    uint16_t type;         // 6
    uint32_t headerBytes;  // 8
    uint32_t payloadBytes; // 12
    uint64_t sessionId;    // 16
    uint64_t sequence;     // 24
    uint64_t timestamp;    // 32, monotonic 100ns ticks
    uint32_t timeoutMs;    // 40
    uint32_t deadlineMs;   // 44, monotonic millisecond deadline
    uint32_t status;       // 48
    uint32_t flags;        // 52
    uint32_t reserved;     // 56
    uint32_t reserved2;    // 60
};
static_assert(sizeof(Header) == 64, "wire header must remain 64 bytes");
static_assert(offsetof(Header, sessionId) == 16 && offsetof(Header, sequence) == 24, "wire ABI offsets");
static_assert(offsetof(Header, timestamp) == 32 && offsetof(Header, timeoutMs) == 40 &&
                  offsetof(Header, deadlineMs) == 44 && offsetof(Header, status) == 48 &&
                  offsetof(Header, flags) == 52 && offsetof(Header, reserved) == 56 &&
                  offsetof(Header, reserved2) == 60,
              "wire ABI offsets");

struct ClientHelloPayload
{
    uint16_t protocolVersion;
    uint16_t headerBytes;
    uint32_t capabilities;
    uint32_t maxReportBytes;
    uint32_t reserved;
};
static_assert(sizeof(ClientHelloPayload) == 16, "wire ABI");
struct ReplyResultPayload
{
    uint32_t code;
    uint32_t reportBytes;
    uint32_t reserved[2];
};
static_assert(sizeof(ReplyResultPayload) == 16, "wire ABI");
struct StatusPayload
{
    uint64_t accepted, expired, invalid, disconnected, dropped;
    uint32_t lastError, reserved;
};
static_assert(sizeof(StatusPayload) == 48, "wire ABI");
struct Packet
{
    Header header;
    uint8_t payload[MaxPayload];
};
inline bool IsKnownType(uint16_t type)
{
    return type >= Hello && type <= Status;
}
inline bool ValidHeader(const Header &h)
{
    if (h.magic != Magic || h.version != Version || h.headerBytes != sizeof(Header) || !IsKnownType(h.type) ||
        h.payloadBytes > MaxPayload || h.reserved || h.reserved2)
        return false;
    switch (h.type)
    {
    case Hello:
        return h.payloadBytes >= sizeof(wchar_t) && (h.payloadBytes % sizeof(wchar_t)) == 0;
    case ClientHello:
        return h.payloadBytes == sizeof(ClientHelloPayload);
    case ReportRequest:
        return h.payloadBytes && h.payloadBytes <= MaxReport;
    case ReportReply:
        return h.payloadBytes && h.payloadBytes <= MaxReport;
    case ReplyResult:
        return h.payloadBytes == sizeof(ReplyResultPayload);
    case Status:
        return h.payloadBytes == sizeof(StatusPayload);
    default:
        return false;
    }
}
inline bool SameTransaction(const Header &a, const Header &b)
{
    return a.sessionId == b.sessionId && a.sequence == b.sequence;
}
} // namespace hid_user
} // namespace quarbor
