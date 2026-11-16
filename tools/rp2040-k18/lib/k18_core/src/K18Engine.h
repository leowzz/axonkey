#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace k18 {

constexpr std::uint16_t kUsbVid = 0x2E8A;
constexpr std::uint16_t kUsbPid = 0xA018;
constexpr std::uint16_t kHidUsagePage = 0xFF60;
constexpr std::uint8_t kHidUsage = 0x01;
constexpr std::uint8_t kProtocolVersion = 1;

constexpr std::size_t kKeyCount = 18;
constexpr std::uint32_t kAllKeysMask = (std::uint32_t{1} << kKeyCount) - 1U;
constexpr std::uint32_t kDebounceUs = 10000U;

constexpr std::uint16_t kDisplayWidth = 128;
constexpr std::uint16_t kDisplayHeight = 32;
constexpr std::uint8_t kTileCols = kDisplayWidth / 8;
constexpr std::uint8_t kTileRows = kDisplayHeight / 8;
constexpr std::size_t kTileCount = static_cast<std::size_t>(kTileCols) * kTileRows;
constexpr std::size_t kFramebufferBytes = (kDisplayWidth * kDisplayHeight) / 8;
constexpr std::uint8_t kPixelFormatRowMajorMsb1Bpp = 1;
constexpr std::uint8_t kCapsHasDisplay = 0x01;

constexpr std::uint8_t kReportIdInput = 0x01;
constexpr std::size_t kInputPayloadBytes = 7;

constexpr std::uint8_t kReportIdOutput = 0x02;
constexpr std::size_t kOutputPayloadBytes = 63;
constexpr std::size_t kOutputWireBytes = 1 + kOutputPayloadBytes;

constexpr std::uint8_t kReportIdFeatureInfo = 0x10;
constexpr std::size_t kFeatureInfoPayloadBytes = 15;

constexpr std::uint8_t kReportIdFeatureState = 0x11;
constexpr std::size_t kFeatureStatePayloadBytes = 7;

constexpr std::uint8_t kHidReportTypeInput = 1;
constexpr std::uint8_t kHidReportTypeOutput = 2;
constexpr std::uint8_t kHidReportTypeFeature = 3;

constexpr std::uint8_t kFlagOledOnline = 0x01;
constexpr std::uint8_t kFlagOledSleeping = 0x02;
constexpr std::uint8_t kFlagHostLeaseActive = 0x04;

constexpr std::uint8_t kOpControlLease = 0x01;
constexpr std::uint8_t kOpFrameChunk = 0x02;

constexpr std::uint8_t kChunkClearStaging = 0x01;
constexpr std::uint8_t kChunkCommit = 0x02;
constexpr std::size_t kMaxChunkDataBytes = 56;

constexpr std::uint8_t kDefaultLeaseSec = 5;
constexpr std::uint8_t kMinLeaseSec = 1;
constexpr std::uint8_t kMaxLeaseSec = 60;
constexpr std::uint8_t kKeepValueUnchanged = 0xFF;
constexpr std::uint8_t kDefaultBrightnessPercent = 100;
constexpr std::uint32_t kIdleSleepMs = 180000U;
constexpr std::uint8_t kDefaultMaxTilesPerFlush = 8;

// Single Top-Level Application Collection (Usage Page 0xFF60, Usage 0x01) so
// Windows and macOS enumerate one vendor HID device handle with zero duplicate
// interfaces.
inline constexpr std::array<std::uint8_t, 47> kHidReportDescriptor = {
    0x06, 0x60, 0xFF,  // Usage Page (Vendor Defined 0xFF60)
    0x09, 0x01,        // Usage (0x01)
    0xA1, 0x01,        // Collection (Application)
    0x15, 0x00,        //   Logical Minimum (0)
    0x26, 0xFF, 0x00,  //   Logical Maximum (255)
    0x75, 0x08,        //   Report Size (8)
    0x85, 0x01,        //   Report ID (0x01)
    0x09, 0x02,        //   Usage (0x02)
    0x95, 0x07,        //   Report Count (7)
    0x81, 0x02,        //   Input (Data, Var, Abs)
    0x85, 0x02,        //   Report ID (0x02)
    0x09, 0x03,        //   Usage (0x03)
    0x95, 0x3F,        //   Report Count (63)
    0x91, 0x02,        //   Output (Data, Var, Abs)
    0x85, 0x10,        //   Report ID (0x10)
    0x09, 0x10,        //   Usage (0x10)
    0x95, 0x0F,        //   Report Count (15)
    0xB1, 0x02,        //   Feature (Data, Var, Abs)
    0x85, 0x11,        //   Report ID (0x11)
    0x09, 0x11,        //   Usage (0x11)
    0x95, 0x07,        //   Report Count (7)
    0xB1, 0x02,        //   Feature (Data, Var, Abs)
    0xC0,              // End Collection
};

enum class DisplaySource : std::uint8_t { Local, Host };

struct TileRun {
  std::uint8_t tx = 0;
  std::uint8_t ty = 0;
  std::uint8_t tw = 0;
};

struct LocalStatusText {
  const char *title = "KIVO K18 LITE";
  const char *state = "READY";
  std::array<char, 4> lastKey{};
};

void transposeTileToSsd1306(
    const std::array<std::uint8_t, kFramebufferBytes> &rowMajor,
    std::uint8_t tx, std::uint8_t ty, std::uint8_t outCols[8]);

class K18Engine {
 public:
  K18Engine();

  void reset(std::uint32_t nowUs = 0, std::uint32_t nowMs = 0);
  void setOledOnline(bool online);

  bool pollKeys(std::uint32_t rawDownMask, std::uint32_t nowUs,
                std::uint32_t nowMs);
  void tick(std::uint32_t nowMs);

  bool hasPendingInputReport() const { return reportPending_; }
  bool hasPendingWakeupPress() const { return wakeupPending_; }
  void prepareInputReport(
      std::array<std::uint8_t, kInputPayloadBytes> &out) const;
  void commitInputReportSent();

  std::uint16_t handleGetReport(std::uint8_t reportId, std::uint8_t reportType,
                                std::uint8_t *buffer,
                                std::uint16_t reqLen) const;
  bool handleSetReport(std::uint8_t reportId, std::uint8_t reportType,
                       const std::uint8_t *buffer, std::uint16_t bufSize,
                       std::uint32_t nowMs);

  std::uint32_t keyBitmap() const { return keyBitmap_; }
  std::uint8_t sequence() const { return seq_; }
  std::uint8_t statusFlags() const;
  std::uint8_t brightnessPercent() const { return brightness_; }
  std::uint8_t contrastByte() const;
  bool oledOnline() const { return oledOnline_; }
  bool sleeping() const { return sleeping_; }
  bool hostLeaseActive() const { return hostLeaseActive_; }
  DisplaySource displaySource() const { return displaySource_; }

  bool takeLocalScreenDirty();
  LocalStatusText localStatusText() const;
  void markDirtyTiles(std::uint64_t mask) { dirtyTiles_ |= mask; }
  std::uint64_t dirtyTileMask() const { return dirtyTiles_; }
  std::optional<TileRun> takeDirtyRun(
      std::uint8_t maxTiles = kDefaultMaxTilesPerFlush);

  const std::array<std::uint8_t, kFramebufferBytes> &activeFramebuffer() const {
    return active_;
  }
  const std::array<std::uint8_t, kFramebufferBytes> &stagingFramebuffer()
      const {
    return staging_;
  }

 private:
  struct KeyState {
    bool pressed = false;
    std::uint32_t lastEdgeUs = 0;
  };

  struct ControlLeaseCmd {
    bool hostOwnsScreen = false;
    std::uint32_t leaseMs = 0;
    std::optional<std::uint8_t> brightness;
    std::optional<bool> sleep;
  };

  struct FrameChunkCmd {
    std::uint8_t frameId = 0;
    bool clearStaging = false;
    bool commit = false;
    std::uint16_t offset = 0;
    std::uint8_t len = 0;
    const std::uint8_t *data = nullptr;
  };

  void applyControlLease(const ControlLeaseCmd &cmd, std::uint32_t nowMs);
  void applyFrameChunk(const FrameChunkCmd &cmd, std::uint32_t nowMs);
  void writeStateSnapshot(std::uint8_t *buffer, std::uint8_t seqValue) const;
  void switchToLocalScreen();

  std::array<KeyState, kKeyCount> keys_{};
  std::uint32_t keyBitmap_ = 0;
  std::uint8_t lastPressedKey_ = 0;
  std::uint8_t seq_ = 0;
  bool reportPending_ = false;
  bool wakeupPending_ = false;

  bool oledOnline_ = false;
  bool sleeping_ = false;
  bool forcedSleep_ = false;
  bool hostLeaseActive_ = false;
  bool hasCommittedHostFrame_ = false;
  DisplaySource displaySource_ = DisplaySource::Local;
  bool localScreenDirty_ = true;

  std::uint8_t brightness_ = kDefaultBrightnessPercent;
  std::uint32_t leaseDurationMs_ = kDefaultLeaseSec * 1000U;
  std::uint32_t leaseStartMs_ = 0;
  std::uint32_t lastActivityMs_ = 0;

  bool hasStagedFrame_ = false;
  std::uint8_t stagedFrameId_ = 0;
  std::array<std::uint8_t, kFramebufferBytes> staging_{};
  std::array<std::uint8_t, kFramebufferBytes> active_{};
  std::uint64_t dirtyTiles_ = 0;
};

}  // namespace k18
