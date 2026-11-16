#include "K18Engine.h"

#include <algorithm>

namespace k18 {
namespace {

constexpr std::uint64_t kAllTilesDirty = ~std::uint64_t{0};

const std::uint8_t *unwrapOutputPayload(std::uint8_t reportId,
                                        std::uint8_t reportType,
                                        const std::uint8_t *buffer,
                                        std::uint16_t bufSize) {
  if (!buffer || reportType != kHidReportTypeOutput) return nullptr;

  // TinyUSB invokes tud_hid_set_report_cb in two distinct shapes:
  // 1) Interrupt OUT endpoint (hidd_xfer_cb): report_id == 0, buffer starts
  //    with the wire Report ID byte (0x02) followed by 63 payload bytes (64B).
  // 2) Control SET_REPORT (hidd_control_xfer_cb): report_id == 0x02, TinyUSB
  //    already stripped buffer[0] so buffer is the 63-byte payload directly.
  if (reportId == 0) {
    if (bufSize != kOutputWireBytes || buffer[0] != kReportIdOutput) {
      return nullptr;
    }
    return buffer + 1;
  }
  if (reportId == kReportIdOutput) {
    if (bufSize == kOutputPayloadBytes) return buffer;
    if (bufSize == kOutputWireBytes && buffer[0] == kReportIdOutput) {
      return buffer + 1;
    }
  }
  return nullptr;
}

std::uint32_t normalizeLeaseMs(std::uint8_t leaseSec) {
  const std::uint8_t clamped =
      leaseSec == 0 ? kDefaultLeaseSec
                    : std::clamp(leaseSec, kMinLeaseSec, kMaxLeaseSec);
  return static_cast<std::uint32_t>(clamped) * 1000U;
}

std::uint64_t diffTiles(
    const std::array<std::uint8_t, kFramebufferBytes> &next,
    const std::array<std::uint8_t, kFramebufferBytes> &prev) {
  std::uint64_t changed = 0;
  for (std::uint8_t ty = 0; ty < kTileRows; ++ty) {
    for (std::uint8_t tx = 0; tx < kTileCols; ++tx) {
      bool tileDiffers = false;
      for (std::uint8_t dy = 0; dy < 8; ++dy) {
        const std::size_t idx =
            static_cast<std::size_t>(ty * 8U + dy) * kTileCols + tx;
        if (next[idx] != prev[idx]) {
          tileDiffers = true;
          break;
        }
      }
      if (tileDiffers) {
        const std::size_t bit = static_cast<std::size_t>(ty) * kTileCols + tx;
        changed |= (std::uint64_t{1} << bit);
      }
    }
  }
  return changed;
}

}  // namespace

void transposeTileToSsd1306(
    const std::array<std::uint8_t, kFramebufferBytes> &rowMajor,
    std::uint8_t tx, std::uint8_t ty, std::uint8_t outCols[8]) {
  for (std::uint8_t dx = 0; dx < 8; ++dx) outCols[dx] = 0;
  if (tx >= kTileCols || ty >= kTileRows) return;

  // Wire format is 1bpp row-major MSB-first; U8g2's SSD1306 buffer uses
  // vertical pages with top pixel in LSB (u8g2_ll_hvline_vertical_top_lsb).
  for (std::uint8_t dy = 0; dy < 8; ++dy) {
    const std::uint8_t rowByte =
        rowMajor[static_cast<std::size_t>(ty * 8U + dy) * kTileCols + tx];
    if (rowByte == 0) continue;
    for (std::uint8_t dx = 0; dx < 8; ++dx) {
      if ((rowByte & (0x80U >> dx)) != 0) {
        outCols[dx] |= static_cast<std::uint8_t>(1U << dy);
      }
    }
  }
}

K18Engine::K18Engine() { reset(0, 0); }

void K18Engine::reset(std::uint32_t nowUs, std::uint32_t nowMs) {
  const std::uint32_t readyEdgeUs = nowUs - kDebounceUs;
  for (auto &key : keys_) {
    key.pressed = false;
    key.lastEdgeUs = readyEdgeUs;
  }
  keyBitmap_ = 0;
  lastPressedKey_ = 0;
  seq_ = 0;
  reportPending_ = false;
  wakeupPending_ = false;

  oledOnline_ = false;
  sleeping_ = false;
  forcedSleep_ = false;
  hostLeaseActive_ = false;
  hasCommittedHostFrame_ = false;
  displaySource_ = DisplaySource::Local;
  localScreenDirty_ = true;

  brightness_ = kDefaultBrightnessPercent;
  leaseDurationMs_ = kDefaultLeaseSec * 1000U;
  leaseStartMs_ = nowMs;
  lastActivityMs_ = nowMs;

  hasStagedFrame_ = false;
  stagedFrameId_ = 0;
  staging_.fill(0);
  active_.fill(0);
  dirtyTiles_ = 0;
}

void K18Engine::setOledOnline(bool online) { oledOnline_ = online; }

bool K18Engine::pollKeys(std::uint32_t rawDownMask, std::uint32_t nowUs,
                         std::uint32_t nowMs) {
  rawDownMask &= kAllKeysMask;
  const std::uint32_t previousBitmap = keyBitmap_;
  bool changed = false;

  for (std::size_t i = 0; i < kKeyCount; ++i) {
    auto &key = keys_[i];
    const bool rawDown = (rawDownMask & (std::uint32_t{1} << i)) != 0;
    const std::uint32_t elapsedUs = nowUs - key.lastEdgeUs;

    if (!key.pressed) {
      if (rawDown) {
        if (elapsedUs >= kDebounceUs) {
          key.pressed = true;
          key.lastEdgeUs = nowUs;
          keyBitmap_ |= (std::uint32_t{1} << i);
          changed = true;
        }
      } else if (elapsedUs > kDebounceUs) {
        // Pin settled idle timestamp so 32-bit micros() wraparound after
        // 71.58 minutes never aliases into the 10ms cooldown window.
        key.lastEdgeUs = nowUs - kDebounceUs;
      }
    } else if (rawDown) {
      key.lastEdgeUs = nowUs;
    } else if (elapsedUs >= kDebounceUs) {
      key.pressed = false;
      key.lastEdgeUs = nowUs;
      keyBitmap_ &= ~(std::uint32_t{1} << i);
      changed = true;
    }
  }

  const std::uint32_t newlyPressed = keyBitmap_ & ~previousBitmap;
  if (newlyPressed != 0) {
    wakeupPending_ = true;
    for (std::uint8_t i = 0; i < kKeyCount; ++i) {
      if ((newlyPressed & (std::uint32_t{1} << i)) != 0) {
        lastPressedKey_ = static_cast<std::uint8_t>(i + 1U);
        if (displaySource_ == DisplaySource::Local) localScreenDirty_ = true;
        break;
      }
    }
  }

  if (changed || keyBitmap_ != 0) {
    lastActivityMs_ = nowMs;
    if (sleeping_ && !forcedSleep_) sleeping_ = false;
  }

  if (changed) reportPending_ = true;
  return changed;
}

void K18Engine::tick(std::uint32_t nowMs) {
  if (hostLeaseActive_ &&
      static_cast<std::uint32_t>(nowMs - leaseStartMs_) >= leaseDurationMs_) {
    switchToLocalScreen();
  }

  if (!sleeping_ && keyBitmap_ == 0 &&
      static_cast<std::uint32_t>(nowMs - lastActivityMs_) >= kIdleSleepMs) {
    sleeping_ = true;
  }
}

void K18Engine::prepareInputReport(
    std::array<std::uint8_t, kInputPayloadBytes> &out) const {
  writeStateSnapshot(out.data(), static_cast<std::uint8_t>(seq_ + 1U));
}

void K18Engine::commitInputReportSent() {
  ++seq_;
  reportPending_ = false;
  wakeupPending_ = false;
}

std::uint16_t K18Engine::handleGetReport(std::uint8_t reportId,
                                         std::uint8_t reportType,
                                         std::uint8_t *buffer,
                                         std::uint16_t reqLen) const {
  if (!buffer) return 0;

  // TinyUSB's GET_REPORT handler already writes report_id to ctrl[0] and
  // passes &ctrl[1] here; callbacks must write only the report payload.
  if (reportType == kHidReportTypeFeature &&
      reportId == kReportIdFeatureInfo) {
    if (reqLen < kFeatureInfoPayloadBytes) return 0;
    buffer[0] = kProtocolVersion;
    buffer[1] = static_cast<std::uint8_t>(kKeyCount);
    buffer[2] = kCapsHasDisplay;
    buffer[3] = static_cast<std::uint8_t>(kDisplayWidth & 0xFFU);
    buffer[4] = static_cast<std::uint8_t>((kDisplayWidth >> 8U) & 0xFFU);
    buffer[5] = static_cast<std::uint8_t>(kDisplayHeight & 0xFFU);
    buffer[6] = static_cast<std::uint8_t>((kDisplayHeight >> 8U) & 0xFFU);
    buffer[7] = kPixelFormatRowMajorMsb1Bpp;
    buffer[8] = brightness_;
    buffer[9] = statusFlags();
    std::fill_n(buffer + 10, 5, std::uint8_t{0});
    return kFeatureInfoPayloadBytes;
  }

  if ((reportType == kHidReportTypeFeature &&
       reportId == kReportIdFeatureState) ||
      (reportType == kHidReportTypeInput && reportId == kReportIdInput)) {
    if (reqLen < kFeatureStatePayloadBytes) return 0;
    writeStateSnapshot(buffer, seq_);
    return kFeatureStatePayloadBytes;
  }

  return 0;
}

bool K18Engine::handleSetReport(std::uint8_t reportId, std::uint8_t reportType,
                                const std::uint8_t *buffer,
                                std::uint16_t bufSize, std::uint32_t nowMs) {
  const std::uint8_t *payload =
      unwrapOutputPayload(reportId, reportType, buffer, bufSize);
  if (!payload) return false;

  const std::uint8_t op = payload[0];
  if (op == kOpControlLease) {
    const std::uint8_t mode = payload[1];
    const std::uint8_t leaseSec = payload[2];
    const std::uint8_t brightness = payload[3];
    const std::uint8_t powerSave = payload[4];
    if (mode > 1) return false;
    if (brightness > 100 && brightness != kKeepValueUnchanged) return false;
    if (powerSave > 1 && powerSave != kKeepValueUnchanged) return false;

    ControlLeaseCmd cmd;
    cmd.hostOwnsScreen = (mode == 1);
    cmd.leaseMs = normalizeLeaseMs(leaseSec);
    if (brightness <= 100) cmd.brightness = brightness;
    if (powerSave <= 1) cmd.sleep = (powerSave == 1);
    applyControlLease(cmd, nowMs);
    return true;
  }

  if (op == kOpFrameChunk) {
    const std::uint8_t frameId = payload[1];
    const std::uint8_t flags = payload[2];
    const std::uint16_t offset = static_cast<std::uint16_t>(payload[3]) |
                                 (static_cast<std::uint16_t>(payload[4]) << 8U);
    const std::uint8_t len = payload[5];
    if (len < 1 || len > kMaxChunkDataBytes) return false;
    if (static_cast<std::uint32_t>(offset) + len > kFramebufferBytes) {
      return false;
    }

    FrameChunkCmd cmd;
    cmd.frameId = frameId;
    cmd.clearStaging = (flags & kChunkClearStaging) != 0;
    cmd.commit = (flags & kChunkCommit) != 0;
    cmd.offset = offset;
    cmd.len = len;
    cmd.data = payload + 6;
    applyFrameChunk(cmd, nowMs);
    return true;
  }

  return false;
}

std::uint8_t K18Engine::statusFlags() const {
  std::uint8_t flags = 0;
  if (oledOnline_) flags |= kFlagOledOnline;
  if (sleeping_) flags |= kFlagOledSleeping;
  if (hostLeaseActive_) flags |= kFlagHostLeaseActive;
  return flags;
}

std::uint8_t K18Engine::contrastByte() const {
  return static_cast<std::uint8_t>(
      (static_cast<std::uint16_t>(brightness_) * 255U + 50U) / 100U);
}

bool K18Engine::takeLocalScreenDirty() {
  if (!localScreenDirty_) return false;
  localScreenDirty_ = false;
  return true;
}

LocalStatusText K18Engine::localStatusText() const {
  LocalStatusText text;
  if (lastPressedKey_ >= 1 && lastPressedKey_ <= kKeyCount) {
    text.lastKey[0] = 'K';
    text.lastKey[1] = static_cast<char>('0' + (lastPressedKey_ / 10U));
    text.lastKey[2] = static_cast<char>('0' + (lastPressedKey_ % 10U));
    text.lastKey[3] = '\0';
  }
  return text;
}

std::optional<TileRun> K18Engine::takeDirtyRun(std::uint8_t maxTiles) {
  if (dirtyTiles_ == 0 || maxTiles == 0) return std::nullopt;

  std::uint8_t first = 0;
  while (first < kTileCount &&
         (dirtyTiles_ & (std::uint64_t{1} << first)) == 0) {
    ++first;
  }
  if (first >= kTileCount) return std::nullopt;

  const std::uint8_t tx = first % kTileCols;
  const std::uint8_t ty = first / kTileCols;
  const std::uint8_t maxInRow = static_cast<std::uint8_t>(kTileCols - tx);
  const std::uint8_t limit = std::min(maxTiles, maxInRow);

  std::uint8_t tw = 0;
  while (tw < limit &&
         (dirtyTiles_ & (std::uint64_t{1} << (first + tw))) != 0) {
    dirtyTiles_ &= ~(std::uint64_t{1} << (first + tw));
    ++tw;
  }

  return TileRun{tx, ty, tw};
}

void K18Engine::applyControlLease(const ControlLeaseCmd &cmd,
                                  std::uint32_t nowMs) {
  lastActivityMs_ = nowMs;
  if (cmd.brightness.has_value()) brightness_ = *cmd.brightness;

  if (cmd.hostOwnsScreen) {
    leaseDurationMs_ = cmd.leaseMs;
    leaseStartMs_ = nowMs;
    hostLeaseActive_ = true;
    if (hasCommittedHostFrame_ && displaySource_ != DisplaySource::Host) {
      displaySource_ = DisplaySource::Host;
      dirtyTiles_ = kAllTilesDirty;
    }
  } else {
    switchToLocalScreen();
  }

  if (cmd.sleep.has_value()) {
    forcedSleep_ = *cmd.sleep && cmd.hostOwnsScreen;
    sleeping_ = *cmd.sleep;
  } else if (sleeping_ && !forcedSleep_) {
    sleeping_ = false;
  }
}

void K18Engine::applyFrameChunk(const FrameChunkCmd &cmd, std::uint32_t nowMs) {
  lastActivityMs_ = nowMs;

  if (cmd.clearStaging) {
    staging_.fill(0);
  } else if (!hasStagedFrame_ || cmd.frameId != stagedFrameId_) {
    staging_ = active_;
  }
  hasStagedFrame_ = true;
  stagedFrameId_ = cmd.frameId;

  std::copy_n(cmd.data, cmd.len, staging_.begin() + cmd.offset);

  if (cmd.commit) {
    // Switching from the local fallback screen to host ownership must repaint
    // every tile so local status glyphs are completely replaced even if active_
    // already held identical bytes from an earlier session.
    const std::uint64_t changedMask =
        displaySource_ == DisplaySource::Host ? diffTiles(staging_, active_)
                                              : kAllTilesDirty;
    active_ = staging_;
    hasCommittedHostFrame_ = true;
    displaySource_ = DisplaySource::Host;
    localScreenDirty_ = false;
    dirtyTiles_ |= changedMask;

    hostLeaseActive_ = true;
    leaseStartMs_ = nowMs;
    if (sleeping_ && !forcedSleep_) sleeping_ = false;
  }
}

void K18Engine::writeStateSnapshot(std::uint8_t *buffer,
                                   std::uint8_t seqValue) const {
  buffer[0] = static_cast<std::uint8_t>(keyBitmap_ & 0xFFU);
  buffer[1] = static_cast<std::uint8_t>((keyBitmap_ >> 8U) & 0xFFU);
  buffer[2] = static_cast<std::uint8_t>((keyBitmap_ >> 16U) & 0xFFU);
  buffer[3] = static_cast<std::uint8_t>((keyBitmap_ >> 24U) & 0xFFU);
  buffer[4] = 0;  // enc_delta (reserved i8 = 0 on K18 Lite)
  buffer[5] = statusFlags();
  buffer[6] = seqValue;
}

void K18Engine::switchToLocalScreen() {
  hostLeaseActive_ = false;
  forcedSleep_ = false;
  if (displaySource_ != DisplaySource::Local) {
    displaySource_ = DisplaySource::Local;
    localScreenDirty_ = true;
    dirtyTiles_ = 0;
  }
}

}  // namespace k18
