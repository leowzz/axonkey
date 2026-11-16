#include <unity.h>

#include <array>
#include <cstdint>
#include <cstring>

#include "K18Engine.h"

namespace {

using k18::DisplaySource;
using k18::K18Engine;

std::array<std::uint8_t, k18::kOutputWireBytes> makeControlLeaseWire(
    std::uint8_t mode, std::uint8_t leaseSec,
    std::uint8_t brightness = k18::kKeepValueUnchanged,
    std::uint8_t powerSave = k18::kKeepValueUnchanged) {
  std::array<std::uint8_t, k18::kOutputWireBytes> wire{};
  wire[0] = k18::kReportIdOutput;
  wire[1] = k18::kOpControlLease;
  wire[2] = mode;
  wire[3] = leaseSec;
  wire[4] = brightness;
  wire[5] = powerSave;
  return wire;
}

std::array<std::uint8_t, k18::kOutputWireBytes> makeFrameChunkWire(
    std::uint8_t frameId, std::uint8_t flags, std::uint16_t offset,
    std::uint8_t len, const std::uint8_t *data) {
  std::array<std::uint8_t, k18::kOutputWireBytes> wire{};
  wire[0] = k18::kReportIdOutput;
  wire[1] = k18::kOpFrameChunk;
  wire[2] = frameId;
  wire[3] = flags;
  wire[4] = static_cast<std::uint8_t>(offset & 0xFFU);
  wire[5] = static_cast<std::uint8_t>((offset >> 8U) & 0xFFU);
  wire[6] = len;
  if (data && len <= k18::kMaxChunkDataBytes) {
    std::memcpy(wire.data() + 7, data, len);
  }
  return wire;
}

bool sendViaInterruptOut(
    K18Engine &engine,
    const std::array<std::uint8_t, k18::kOutputWireBytes> &wire,
    std::uint32_t nowMs) {
  return engine.handleSetReport(0, k18::kHidReportTypeOutput, wire.data(),
                                static_cast<std::uint16_t>(wire.size()), nowMs);
}

bool sendViaControlSetReportStripped(
    K18Engine &engine,
    const std::array<std::uint8_t, k18::kOutputWireBytes> &wire,
    std::uint32_t nowMs) {
  return engine.handleSetReport(
      k18::kReportIdOutput, k18::kHidReportTypeOutput, wire.data() + 1,
      static_cast<std::uint16_t>(k18::kOutputPayloadBytes), nowMs);
}

void test_hid_descriptor_has_single_vendor_collection_and_exact_reports() {
  const auto &desc = k18::kHidReportDescriptor;
  TEST_ASSERT_EQUAL_HEX8(0x06, desc[0]);
  TEST_ASSERT_EQUAL_HEX8(0x60, desc[1]);
  TEST_ASSERT_EQUAL_HEX8(0xFF, desc[2]);
  TEST_ASSERT_EQUAL_HEX8(0x09, desc[3]);
  TEST_ASSERT_EQUAL_HEX8(0x01, desc[4]);

  int appCollections = 0;
  int endCollections = 0;
  std::size_t i = 0;
  while (i < desc.size()) {
    const std::uint8_t prefix = desc[i];
    const std::size_t sizeCode = prefix & 0x03U;
    const std::size_t payloadLen = (sizeCode == 3) ? 4 : sizeCode;
    TEST_ASSERT_TRUE(i + 1 + payloadLen <= desc.size());
    if (prefix == 0xA1 && desc[i + 1] == 0x01) ++appCollections;
    if (prefix == 0xC0) ++endCollections;
    i += 1 + payloadLen;
  }

  TEST_ASSERT_EQUAL_UINT32(desc.size(), i);
  TEST_ASSERT_EQUAL_INT(1, appCollections);
  TEST_ASSERT_EQUAL_INT(1, endCollections);
}

void test_eager_press_hold_chatter_and_deferred_release_per_key() {
  K18Engine engine;
  engine.reset(100, 0);

  // Immediate eager press at boot without waiting 10ms.
  TEST_ASSERT_TRUE(engine.pollKeys(0x00001U, 200, 0));
  TEST_ASSERT_EQUAL_HEX32(0x00001U, engine.keyBitmap());
  TEST_ASSERT_TRUE(engine.hasPendingInputReport());
  TEST_ASSERT_TRUE(engine.hasPendingWakeupPress());
  engine.commitInputReportSent();

  // Contact bounce open for < 10ms right after press is ignored.
  TEST_ASSERT_FALSE(engine.pollKeys(0x00000U, 5000, 5));
  TEST_ASSERT_FALSE(engine.pollKeys(0x00000U, 10199, 10));
  TEST_ASSERT_EQUAL_HEX32(0x00001U, engine.keyBitmap());

  // Hold re-contact at 9.5ms refreshes lastEdgeUs so later micro-chatter
  // during a held modifier never drops the key.
  TEST_ASSERT_FALSE(engine.pollKeys(0x00001U, 9700, 9));
  TEST_ASSERT_FALSE(engine.pollKeys(0x00001U, 50000, 50));
  TEST_ASSERT_FALSE(engine.pollKeys(0x00000U, 59999, 59));
  TEST_ASSERT_EQUAL_HEX32(0x00001U, engine.keyBitmap());

  // Re-closing contact at 59.999ms resets the 10ms release timer again.
  TEST_ASSERT_FALSE(engine.pollKeys(0x00001U, 60000, 60));
  TEST_ASSERT_FALSE(engine.pollKeys(0x00000U, 69999, 69));
  TEST_ASSERT_EQUAL_HEX32(0x00001U, engine.keyBitmap());

  // Clean release completes at exactly +10000us after last held sample.
  TEST_ASSERT_TRUE(engine.pollKeys(0x00000U, 70000, 70));
  TEST_ASSERT_EQUAL_HEX32(0x00000U, engine.keyBitmap());
  TEST_ASSERT_TRUE(engine.hasPendingInputReport());
  TEST_ASSERT_FALSE(engine.hasPendingWakeupPress());
  engine.commitInputReportSent();

  // Release bounce within < 10ms after release transition cannot re-trigger.
  TEST_ASSERT_FALSE(engine.pollKeys(0x00001U, 75000, 75));
  TEST_ASSERT_FALSE(engine.pollKeys(0x00001U, 79999, 79));
  TEST_ASSERT_EQUAL_HEX32(0x00000U, engine.keyBitmap());

  // New press at +10000us after release fires immediately.
  TEST_ASSERT_TRUE(engine.pollKeys(0x00001U, 80000, 80));
  TEST_ASSERT_EQUAL_HEX32(0x00001U, engine.keyBitmap());
}

void test_all_18_keys_independent_nkro_and_micros_wraparound() {
  K18Engine engine;
  const std::uint32_t nearWrapUs = 0xFFFFFF00U;
  engine.reset(nearWrapUs, 0);

  // Upper bits outside K01..K18 are ignored; all 18 keys press together.
  TEST_ASSERT_TRUE(engine.pollKeys(0xFFFFFFFFU, nearWrapUs + 50U, 0));
  TEST_ASSERT_EQUAL_HEX32(k18::kAllKeysMask, engine.keyBitmap());

  // Release K01 and K18 across 32-bit micros() wraparound while holding K02..K17.
  const std::uint32_t middleHeld = k18::kAllKeysMask & ~((1U << 0) | (1U << 17));
  TEST_ASSERT_FALSE(engine.pollKeys(middleHeld, nearWrapUs + 5000U, 5));
  TEST_ASSERT_TRUE(engine.pollKeys(middleHeld, nearWrapUs + 10050U, 10));
  TEST_ASSERT_EQUAL_HEX32(middleHeld, engine.keyBitmap());

  // Release all keys, then advance > 71.58 minutes (full 32-bit wrap) of idle
  // polling and confirm K01 still triggers eagerly even inside the wrapped window.
  TEST_ASSERT_TRUE(engine.pollKeys(0, nearWrapUs + 25000U, 25));
  TEST_ASSERT_EQUAL_HEX32(0, engine.keyBitmap());
  const std::uint32_t releaseUs = nearWrapUs + 25000U;
  TEST_ASSERT_FALSE(engine.pollKeys(0, releaseUs + 50000U, 75));
  // Exact 2^32 wrap back to releaseUs + 500us: because idle clamped lastEdgeUs,
  // eager press still fires immediately.
  TEST_ASSERT_TRUE(engine.pollKeys(1U, releaseUs + 500U, 4295000));
  TEST_ASSERT_EQUAL_HEX32(1U, engine.keyBitmap());
}

void test_input_and_feature_reports_match_wire_contract() {
  K18Engine engine;
  engine.setOledOnline(true);

  std::array<std::uint8_t, 16> feat10{};
  TEST_ASSERT_EQUAL_UINT16(0, engine.handleGetReport(0x10, k18::kHidReportTypeFeature,
                                                     feat10.data(), 14));
  TEST_ASSERT_EQUAL_UINT16(
      15, engine.handleGetReport(0x10, k18::kHidReportTypeFeature,
                                 feat10.data(), 15));
  TEST_ASSERT_EQUAL_UINT8(1, feat10[0]);
  TEST_ASSERT_EQUAL_UINT8(18, feat10[1]);
  TEST_ASSERT_EQUAL_HEX8(0x01, feat10[2]);
  TEST_ASSERT_EQUAL_UINT8(128, feat10[3]);
  TEST_ASSERT_EQUAL_UINT8(0, feat10[4]);
  TEST_ASSERT_EQUAL_UINT8(32, feat10[5]);
  TEST_ASSERT_EQUAL_UINT8(0, feat10[6]);
  TEST_ASSERT_EQUAL_UINT8(1, feat10[7]);
  TEST_ASSERT_EQUAL_UINT8(100, feat10[8]);
  TEST_ASSERT_EQUAL_HEX8(k18::kFlagOledOnline, feat10[9]);
  for (int i = 10; i < 15; ++i) TEST_ASSERT_EQUAL_UINT8(0, feat10[i]);

  // Press K01 (bit 0), K09 (bit 8), K18 (bit 17).
  const std::uint32_t chord = (1U << 0) | (1U << 8) | (1U << 17);
  TEST_ASSERT_TRUE(engine.pollKeys(chord, 1000, 1));

  std::array<std::uint8_t, k18::kInputPayloadBytes> input{};
  engine.prepareInputReport(input);
  TEST_ASSERT_EQUAL_HEX8(0x01, input[0]);
  TEST_ASSERT_EQUAL_HEX8(0x01, input[1]);
  TEST_ASSERT_EQUAL_HEX8(0x02, input[2]);
  TEST_ASSERT_EQUAL_HEX8(0x00, input[3]);
  TEST_ASSERT_EQUAL_UINT8(0, input[4]);
  TEST_ASSERT_EQUAL_HEX8(k18::kFlagOledOnline, input[5]);
  TEST_ASSERT_EQUAL_UINT8(1, input[6]);
  engine.commitInputReportSent();

  std::array<std::uint8_t, 8> feat11{};
  TEST_ASSERT_EQUAL_UINT16(
      7, engine.handleGetReport(0x11, k18::kHidReportTypeFeature, feat11.data(),
                                7));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(input.data(), feat11.data(), 7);
}

void test_output_report_unwrapping_handles_both_tinyusb_paths() {
  K18Engine engine;
  engine.setOledOnline(true);

  // Path 1: Interrupt OUT endpoint (report_id = 0, 64B with leading 0x02).
  const auto leaseWire = makeControlLeaseWire(1, 0, 40, 0);
  TEST_ASSERT_TRUE(sendViaInterruptOut(engine, leaseWire, 100));
  TEST_ASSERT_TRUE(engine.hostLeaseActive());
  TEST_ASSERT_EQUAL_UINT8(40, engine.brightnessPercent());

  // Path 2: Control SET_REPORT where TinyUSB already stripped report_id 0x02
  // leaving 63B starting with op=0x02 (FRAME_CHUNK). Ensure op=0x02 is NOT
  // misidentified as a second report_id byte!
  std::array<std::uint8_t, 8> pixels = {0xAA, 0x55, 0xF0, 0x0F,
                                        0x12, 0x34, 0x56, 0x78};
  const auto chunkWire = makeFrameChunkWire(
      1, k18::kChunkClearStaging | k18::kChunkCommit, 0, 8, pixels.data());
  TEST_ASSERT_TRUE(sendViaControlSetReportStripped(engine, chunkWire, 110));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(pixels.data(),
                                engine.activeFramebuffer().data(), 8);
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplaySource::Host),
                        static_cast<int>(engine.displaySource()));

  // Entry validation rejects malformed bounds without corrupting staging/active.
  const auto badLenZero = makeFrameChunkWire(2, k18::kChunkCommit, 0, 0, nullptr);
  TEST_ASSERT_FALSE(sendViaInterruptOut(engine, badLenZero, 120));
  const auto badLen57 = makeFrameChunkWire(2, k18::kChunkCommit, 0, 57, nullptr);
  TEST_ASSERT_FALSE(sendViaControlSetReportStripped(engine, badLen57, 120));
  const auto badOverflow =
      makeFrameChunkWire(2, k18::kChunkCommit, 505, 8, pixels.data());
  TEST_ASSERT_FALSE(sendViaInterruptOut(engine, badOverflow, 120));
  const auto badLease = makeControlLeaseWire(2, 5, 101, 0);
  TEST_ASSERT_FALSE(sendViaInterruptOut(engine, badLease, 120));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(pixels.data(),
                                engine.activeFramebuffer().data(), 8);
}

void test_ten_chunk_full_frame_delta_tiles_lease_expiry_and_burnin_sleep() {
  K18Engine engine;
  engine.setOledOnline(true);
  TEST_ASSERT_TRUE(engine.takeLocalScreenDirty());

  // Acquire default 5s lease (lease_sec = 0 -> 5000ms).
  TEST_ASSERT_TRUE(sendViaInterruptOut(engine, makeControlLeaseWire(1, 0), 1000));

  // Send 512B frame across 10 packets (9 * 56B + 1 * 8B).
  std::array<std::uint8_t, k18::kFramebufferBytes> frame{};
  for (std::size_t i = 0; i < frame.size(); ++i) {
    frame[i] = static_cast<std::uint8_t>((i * 7U + 3U) & 0xFFU);
  }
  for (std::size_t chunkIdx = 0; chunkIdx < 10; ++chunkIdx) {
    const std::uint16_t offset = static_cast<std::uint16_t>(chunkIdx * 56U);
    const std::uint8_t len =
        static_cast<std::uint8_t>(chunkIdx == 9 ? 8U : 56U);
    std::uint8_t flags = 0;
    if (chunkIdx == 0) flags |= k18::kChunkClearStaging;
    if (chunkIdx == 9) flags |= k18::kChunkCommit;
    const auto wire =
        makeFrameChunkWire(7, flags, offset, len, frame.data() + offset);
    TEST_ASSERT_TRUE(sendViaInterruptOut(engine, wire, 1200));
  }

  TEST_ASSERT_EQUAL_UINT8_ARRAY(frame.data(), engine.activeFramebuffer().data(),
                                frame.size());
  // Transition from Local -> Host marks all 64 tiles dirty; draining with
  // maxTiles=8 yields 8 runs (2 runs per 16-tile row * 4 rows).
  int runCount = 0;
  int totalTiles = 0;
  while (const auto run = engine.takeDirtyRun(8)) {
    TEST_ASSERT_TRUE(run->tw >= 1 && run->tw <= 8);
    totalTiles += run->tw;
    ++runCount;
  }
  TEST_ASSERT_EQUAL_INT(8, runCount);
  TEST_ASSERT_EQUAL_INT(64, totalTiles);

  // Delta frame (frame_id=8 without CLEAR_STAGING) modifying a single byte in
  // tile (tx=3, ty=2) -> row y=17, byte 17*16 + 3 = 275.
  const std::uint8_t modifiedByte = frame[275] ^ 0xFFU;
  const auto deltaWire =
      makeFrameChunkWire(8, k18::kChunkCommit, 275, 1, &modifiedByte);
  TEST_ASSERT_TRUE(sendViaControlSetReportStripped(engine, deltaWire, 2000));
  const auto singleRun = engine.takeDirtyRun(8);
  TEST_ASSERT_TRUE(singleRun.has_value());
  TEST_ASSERT_EQUAL_UINT8(3, singleRun->tx);
  TEST_ASSERT_EQUAL_UINT8(2, singleRun->ty);
  TEST_ASSERT_EQUAL_UINT8(1, singleRun->tw);
  TEST_ASSERT_FALSE(engine.takeDirtyRun(8).has_value());

  // Lease refreshed at t=2000ms with 5000ms duration: active at 6999ms, expires
  // at 7000ms back to Local screen.
  engine.tick(6999);
  TEST_ASSERT_TRUE(engine.hostLeaseActive());
  engine.tick(7000);
  TEST_ASSERT_FALSE(engine.hostLeaseActive());
  TEST_ASSERT_EQUAL_INT(static_cast<int>(DisplaySource::Local),
                        static_cast<int>(engine.displaySource()));
  TEST_ASSERT_TRUE(engine.takeLocalScreenDirty());

  // Press K18 in standalone local mode -> local status shows "K18".
  TEST_ASSERT_TRUE(engine.pollKeys(1U << 17, 7000000, 7000));
  TEST_ASSERT_TRUE(engine.pollKeys(0, 7020000, 7020));
  const auto status = engine.localStatusText();
  TEST_ASSERT_EQUAL_STRING("KIVO K18 LITE", status.title);
  TEST_ASSERT_EQUAL_STRING("READY", status.state);
  TEST_ASSERT_EQUAL_STRING("K18", status.lastKey.data());

  // Re-committing the EXACT SAME host byte after returning to Local must still
  // mark all 64 tiles dirty so Local screen text is overwritten.
  TEST_ASSERT_TRUE(sendViaInterruptOut(engine, deltaWire, 7100));
  TEST_ASSERT_EQUAL_HEX64(~std::uint64_t{0}, engine.dirtyTileMask());

  // Burn-in auto-sleep after 180,000ms of no key or host activity, then wake on
  // key press.
  engine.tick(7100 + 179999);
  TEST_ASSERT_FALSE(engine.sleeping());
  engine.tick(7100 + 180000);
  TEST_ASSERT_TRUE(engine.sleeping());
  TEST_ASSERT_TRUE((engine.statusFlags() & k18::kFlagOledSleeping) != 0);

  TEST_ASSERT_TRUE(engine.pollKeys(1U << 0, 200000000, 190000));
  TEST_ASSERT_FALSE(engine.sleeping());
}

void test_transpose_tile_row_major_msb_to_ssd1306_vertical_lsb() {
  std::array<std::uint8_t, k18::kFramebufferBytes> fb{};
  // Light (x=0, y=0) -> byte 0 bit 7 (0x80), (x=7, y=0) -> byte 0 bit 0 (0x01),
  // and (x=0, y=7) -> byte 7*16=112 bit 7 (0x80).
  fb[0] = 0x81;
  fb[7 * 16] = 0x80;

  std::uint8_t cols[8] = {};
  k18::transposeTileToSsd1306(fb, 0, 0, cols);
  TEST_ASSERT_EQUAL_HEX8(0x81, cols[0]);  // x=0 has y=0 (bit0) and y=7 (bit7)
  for (int x = 1; x <= 6; ++x) TEST_ASSERT_EQUAL_HEX8(0x00, cols[x]);
  TEST_ASSERT_EQUAL_HEX8(0x01, cols[7]);  // x=7 has y=0 (bit0)
}

void test_forced_sleep_lease_clamping_and_seq_wraparound() {
  K18Engine engine;
  engine.setOledOnline(true);

  // lease_sec=200 clamps to 60s (60,000ms); power_save=1 forces sleep.
  TEST_ASSERT_TRUE(
      sendViaInterruptOut(engine, makeControlLeaseWire(1, 200, 50, 1), 1000));
  TEST_ASSERT_TRUE(engine.sleeping());
  TEST_ASSERT_EQUAL_UINT8(50, engine.brightnessPercent());
  TEST_ASSERT_EQUAL_UINT8(128, engine.contrastByte());

  // COMMIT does not wake an explicitly forced-asleep OLED.
  const std::uint8_t px = 0xFF;
  TEST_ASSERT_TRUE(sendViaInterruptOut(
      engine, makeFrameChunkWire(1, k18::kChunkCommit, 0, 1, &px), 2000));
  TEST_ASSERT_TRUE(engine.sleeping());

  // 60s clamped lease stays active at 2000 + 59,999ms and expires at +60,000ms.
  engine.tick(61999);
  TEST_ASSERT_TRUE(engine.hostLeaseActive());
  engine.tick(62000);
  TEST_ASSERT_FALSE(engine.hostLeaseActive());

  // Sequence counter wraps cleanly 255 -> 0 -> 1.
  std::array<std::uint8_t, k18::kInputPayloadBytes> input{};
  for (int i = 0; i < 256; ++i) {
    engine.prepareInputReport(input);
    engine.commitInputReportSent();
  }
  TEST_ASSERT_EQUAL_UINT8(0, engine.sequence());
  engine.prepareInputReport(input);
  TEST_ASSERT_EQUAL_UINT8(1, input[6]);
}

}  // namespace

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_hid_descriptor_has_single_vendor_collection_and_exact_reports);
  RUN_TEST(test_eager_press_hold_chatter_and_deferred_release_per_key);
  RUN_TEST(test_all_18_keys_independent_nkro_and_micros_wraparound);
  RUN_TEST(test_input_and_feature_reports_match_wire_contract);
  RUN_TEST(test_output_report_unwrapping_handles_both_tinyusb_paths);
  RUN_TEST(test_ten_chunk_full_frame_delta_tiles_lease_expiry_and_burnin_sleep);
  RUN_TEST(test_transpose_tile_row_major_msb_to_ssd1306_vertical_lsb);
  RUN_TEST(test_forced_sleep_lease_clamping_and_seq_wraparound);
  return UNITY_END();
}
