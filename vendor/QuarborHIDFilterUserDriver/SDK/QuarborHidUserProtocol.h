#pragma once
#include <stdint.h>
#include <stddef.h>

// Wire format v1: little endian, 48-byte header followed by payloadBytes bytes.
// No pointers, handles, compiler-dependent enums or native size_t on the wire.
namespace quarbor { namespace hid_user {
constexpr wchar_t PipePrefix[] = L"Quarbor.HidUserFilter.v1.";
constexpr uint32_t Magic = 0x31464851; // "QHF1"
constexpr uint16_t Version = 1;
constexpr uint16_t Hello = 1, Report = 2, Status = 3;
constexpr uint32_t MaxPayload = 4096;
constexpr uint32_t RingCapacity = 64;
struct Header {
    uint32_t magic;
    uint16_t version;
    uint16_t type;
    uint32_t headerBytes;
    uint32_t payloadBytes;
    uint64_t sequence;       // Reports observed since this device object was created.
    uint64_t timestamp;      // UTC FILETIME, 100 ns units.
    uint64_t dropped;        // Reports discarded before/during delivery (see README).
    uint32_t status;         // Last lower-read NTSTATUS; zero means success.
    uint32_t reserved;
};
static_assert(sizeof(Header) == 48 && offsetof(Header, sequence) == 16, "wire ABI");
struct Packet { Header header; uint8_t payload[MaxPayload]; };
inline bool ValidHeader(const Header& h) {
    return h.magic == Magic && h.version == Version && h.headerBytes == sizeof(Header) &&
        h.reserved == 0 && h.payloadBytes <= MaxPayload &&
        ((h.type == Hello && h.payloadBytes >= 2 && h.payloadBytes % 2 == 0) ||
         (h.type == Report && h.payloadBytes != 0) || (h.type == Status && h.payloadBytes == 0));
}
} }
