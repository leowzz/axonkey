#include "OledDisplay.h"

#include <Arduino.h>
#include <Wire.h>
#include <hardware/sync.h>

#include <algorithm>
#include <optional>

namespace k18 {
namespace {

constexpr pin_size_t kOledSdaPin = 28;
constexpr pin_size_t kOledSclPin = 29;
constexpr std::uint8_t kOledI2cAddress = 0x3C;
constexpr std::uint32_t kOledClockHz = 400000;
constexpr std::uint32_t kI2cTimeoutMs = 5;
constexpr std::uint64_t kAllTilesMask = ~std::uint64_t{0};

struct DisplayWorkItem {
  bool desiredSleeping = false;
  std::uint8_t desiredContrast = 0;
  DisplaySource source = DisplaySource::Local;
  bool redrawLocal = false;
  LocalStatusText localText{};
  std::optional<TileRun> run;
  std::array<std::uint8_t, kDefaultMaxTilesPerFlush * 8U> hostTileBytes{};
};

DisplayWorkItem snapshotWork(K18Engine &engine, bool appliedSleeping,
                             std::uint8_t appliedContrast) {
  DisplayWorkItem work;
  const std::uint32_t irqState = save_and_disable_interrupts();
  work.desiredSleeping = engine.sleeping();
  work.desiredContrast = engine.contrastByte();
  work.source = engine.displaySource();

  if (work.desiredContrast == appliedContrast &&
      work.desiredSleeping == appliedSleeping) {
    if (work.source == DisplaySource::Local && engine.takeLocalScreenDirty()) {
      work.redrawLocal = true;
      work.localText = engine.localStatusText();
    } else {
      work.run = engine.takeDirtyRun(kDefaultMaxTilesPerFlush);
      if (work.run.has_value() && work.source == DisplaySource::Host) {
        for (std::uint8_t i = 0; i < work.run->tw; ++i) {
          transposeTileToSsd1306(engine.activeFramebuffer(),
                                 static_cast<std::uint8_t>(work.run->tx + i),
                                 work.run->ty,
                                 work.hostTileBytes.data() + i * 8U);
        }
      }
    }
  }
  restore_interrupts(irqState);
  return work;
}

}  // namespace

bool OledDisplay::begin(std::uint8_t initialContrast) {
  online_ = false;
  healthy_ = false;
  lastBufferWasLocal_ = false;

  if (!Wire.setSDA(kOledSdaPin) || !Wire.setSCL(kOledSclPin)) return false;
  Wire.setTimeout(kI2cTimeoutMs);
  Wire.begin();
  Wire.setClock(kOledClockHz);

  Wire.beginTransmission(kOledI2cAddress);
  if (Wire.endTransmission() != 0) return false;

  u8g2_Setup_ssd1306_i2c_128x32_univision_f(
      screen_.getU8g2(), U8G2_R0, i2cTransfer, u8x8_gpio_and_delay_arduino);
  screen_.setUserPtr(this);
  u8x8_SetPin_HW_I2C(screen_.getU8x8(), U8X8_PIN_NONE);
  screen_.setI2CAddress(kOledI2cAddress << 1U);
  screen_.setBusClock(kOledClockHz);

  healthy_ = true;
  // U8g2::begin clears all tiles synchronously; initDisplay initializes the
  // controller and lets service() flush dirty tiles in bounded per-loop steps.
  screen_.initDisplay();
  screen_.setPowerSave(0);
  screen_.setContrast(initialContrast);
  if (!healthy_) return false;

  screen_.clearBuffer();
  appliedSleeping_ = false;
  appliedContrast_ = initialContrast;
  online_ = true;
  return true;
}

void OledDisplay::service(K18Engine &engine) {
  if (!online()) return;

  const DisplayWorkItem work =
      snapshotWork(engine, appliedSleeping_, appliedContrast_);

  if (work.redrawLocal) {
    const std::uint64_t dirtyMask = renderLocalBuffer(work.localText);
    const std::uint32_t irqState = save_and_disable_interrupts();
    if (engine.displaySource() == DisplaySource::Local) {
      engine.markDirtyTiles(dirtyMask);
    }
    restore_interrupts(irqState);
  }

  if (work.desiredContrast != appliedContrast_) {
    screen_.setContrast(work.desiredContrast);
    appliedContrast_ = work.desiredContrast;
  } else if (work.desiredSleeping != appliedSleeping_) {
    screen_.setPowerSave(work.desiredSleeping ? 1 : 0);
    appliedSleeping_ = work.desiredSleeping;
  } else if (work.run.has_value()) {
    if (work.source == DisplaySource::Host) {
      std::uint8_t *buf = screen_.getBufferPtr();
      const std::size_t dstOffset =
          static_cast<std::size_t>(work.run->ty) * kDisplayWidth +
          static_cast<std::size_t>(work.run->tx) * 8U;
      std::copy_n(work.hostTileBytes.data(),
                  static_cast<std::size_t>(work.run->tw) * 8U, buf + dstOffset);
      lastBufferWasLocal_ = false;
    }
    screen_.updateDisplayArea(work.run->tx, work.run->ty, work.run->tw, 1);
  }

  if (!healthy_) {
    online_ = false;
    const std::uint32_t irqState = save_and_disable_interrupts();
    engine.setOledOnline(false);
    restore_interrupts(irqState);
  }
}

std::uint8_t OledDisplay::i2cTransfer(u8x8_t *u8x8, std::uint8_t msg,
                                      std::uint8_t argInt, void *argPtr) {
  auto *self = static_cast<OledDisplay *>(u8x8_GetUserPtr(u8x8));
  if (!self || !self->healthy_) return 0;

  switch (msg) {
    case U8X8_MSG_BYTE_INIT:
    case U8X8_MSG_BYTE_SET_DC:
      return 1;
    case U8X8_MSG_BYTE_START_TRANSFER:
      Wire.beginTransmission(u8x8_GetI2CAddress(u8x8) >> 1U);
      return 1;
    case U8X8_MSG_BYTE_SEND: {
      const auto written =
          Wire.write(static_cast<const std::uint8_t *>(argPtr), argInt);
      self->healthy_ = (written == argInt) && !Wire.getTimeoutFlag();
      return self->healthy_ ? 1 : 0;
    }
    case U8X8_MSG_BYTE_END_TRANSFER: {
      const std::uint8_t status = Wire.endTransmission();
      self->healthy_ = (status == 0) && !Wire.getTimeoutFlag() && self->healthy_;
      return self->healthy_ ? 1 : 0;
    }
    default:
      return 0;
  }
}

std::uint64_t OledDisplay::renderLocalBuffer(const LocalStatusText &text) {
  std::array<std::uint8_t, kFramebufferBytes> previous{};
  const bool canDiffPrevious = lastBufferWasLocal_;
  if (canDiffPrevious) {
    std::copy_n(screen_.getBufferPtr(), kFramebufferBytes, previous.begin());
  }

  screen_.clearBuffer();
  screen_.setFont(u8g2_font_6x13_tf);
  screen_.setFontPosBaseline();
  screen_.drawStr(0, 11, text.title);
  screen_.drawStr(0, 29, text.state);
  if (text.lastKey[0] != '\0') {
    const u8g2_uint_t keyWidth = screen_.getStrWidth(text.lastKey.data());
    const u8g2_uint_t x =
        keyWidth < kDisplayWidth ? (kDisplayWidth - keyWidth) : 0;
    screen_.drawStr(x, 29, text.lastKey.data());
  }
  lastBufferWasLocal_ = true;

  if (!canDiffPrevious) return kAllTilesMask;

  const std::uint8_t *current = screen_.getBufferPtr();
  std::uint64_t changed = 0;
  for (std::uint8_t ty = 0; ty < kTileRows; ++ty) {
    for (std::uint8_t tx = 0; tx < kTileCols; ++tx) {
      const std::size_t offset =
          static_cast<std::size_t>(ty) * kDisplayWidth + tx * 8U;
      if (!std::equal(previous.begin() + offset, previous.begin() + offset + 8U,
                      current + offset)) {
        changed |= (std::uint64_t{1}
                    << (static_cast<std::size_t>(ty) * kTileCols + tx));
      }
    }
  }
  return changed;
}

}  // namespace k18
