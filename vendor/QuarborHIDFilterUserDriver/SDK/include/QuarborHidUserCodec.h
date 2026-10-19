#pragma once
#include "QuarborHidUserProtocol.h"

namespace quarbor { namespace hid_user {
// Frames are uint32 LE length + protobuf. Decoders receive only protobuf bytes.
// No allocation, no I/O. Destination is committed only after complete validation.
uint32_t ReadFrameLength(const uint8_t* prefix);
bool EncodeClientFrame(const Packet& packet, uint8_t* frame, size_t capacity, size_t& length);
bool DecodeClientMessage(const uint8_t* bytes, size_t length, Packet& packet);
bool EncodeServerFrame(const Packet& packet, uint8_t* frame, size_t capacity, size_t& length);
bool DecodeServerMessage(const uint8_t* bytes, size_t length, Packet& packet);
} }
