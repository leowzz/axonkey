#pragma once

#include <U8g2lib.h>

#include <array>
#include <cstdint>

#include "K18Engine.h"

namespace k18 {

class OledDisplay {
 public:
  bool begin(std::uint8_t initialContrast);
  void service(K18Engine &engine);

  bool online() const { return online_ && healthy_; }

 private:
  static std::uint8_t i2cTransfer(u8x8_t *u8x8, std::uint8_t msg,
                                  std::uint8_t argInt, void *argPtr);
  std::uint64_t renderLocalBuffer(const LocalStatusText &text);

  U8G2 screen_;
  bool online_ = false;
  bool healthy_ = false;
  bool appliedSleeping_ = false;
  std::uint8_t appliedContrast_ = 0xFF;
  bool lastBufferWasLocal_ = false;
};

}  // namespace k18
