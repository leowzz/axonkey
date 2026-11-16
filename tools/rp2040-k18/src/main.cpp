#include <Adafruit_TinyUSB.h>
#include <Arduino.h>
#include <hardware/sync.h>

#include <array>
#include <cstdint>

#include "K18Engine.h"
#include "OledDisplay.h"

static_assert(HID_REPORT_TYPE_INPUT == k18::kHidReportTypeInput,
              "TinyUSB Input report type mismatch");
static_assert(HID_REPORT_TYPE_OUTPUT == k18::kHidReportTypeOutput,
              "TinyUSB Output report type mismatch");
static_assert(HID_REPORT_TYPE_FEATURE == k18::kHidReportTypeFeature,
              "TinyUSB Feature report type mismatch");

namespace {

constexpr std::uint32_t kWatchdogTimeoutMs = 8000;

Adafruit_USBD_HID usbHid;
k18::K18Engine engine;
k18::OledDisplay oled;

std::uint16_t onGetReport(std::uint8_t reportId, hid_report_type_t reportType,
                          std::uint8_t *buffer, std::uint16_t reqLen) {
  return engine.handleGetReport(reportId, static_cast<std::uint8_t>(reportType),
                                buffer, reqLen);
}

void onSetReport(std::uint8_t reportId, hid_report_type_t reportType,
                 const std::uint8_t *buffer, std::uint16_t bufSize) {
  engine.handleSetReport(reportId, static_cast<std::uint8_t>(reportType),
                         buffer, bufSize, millis());
}

void configureKeyPins() {
  for (std::uint8_t pin = 1; pin <= k18::kKeyCount; ++pin) {
    pinMode(static_cast<pin_size_t>(pin), INPUT_PULLUP);
  }
}

std::uint32_t sampleRawKeyMask() {
  std::uint32_t mask = 0;
  for (std::uint8_t i = 0; i < k18::kKeyCount; ++i) {
    if (digitalRead(static_cast<pin_size_t>(i + 1U)) == LOW) {
      mask |= (std::uint32_t{1} << i);
    }
  }
  return mask;
}

void configureUsb() {
  if (!TinyUSBDevice.isInitialized()) {
    TinyUSBDevice.begin(0);
  }

  TinyUSBDevice.setID(k18::kUsbVid, k18::kUsbPid);
  TinyUSBDevice.setManufacturerDescriptor("Kivo");
  TinyUSBDevice.setProductDescriptor("Kivo K18 Lite");
  // Keep default USB serial descriptor unset so Earle Philhower's core exposes
  // the unique RP2040 flash chip ID, and keep default 115200 CDC active so
  // 1200bps auto-reset picotool works without opening the enclosure.
  Serial.begin(115200);

  usbHid.enableOutEndpoint(true);
  usbHid.setBootProtocol(HID_ITF_PROTOCOL_NONE);
  usbHid.setPollInterval(1);
  usbHid.setReportDescriptor(k18::kHidReportDescriptor.data(),
                             k18::kHidReportDescriptor.size());
  usbHid.setReportCallback(onGetReport, onSetReport);
  usbHid.begin();

  if (TinyUSBDevice.mounted()) {
    TinyUSBDevice.detach();
    delay(10);
    TinyUSBDevice.attach();
  }
}

void pollAndSendKeys() {
  const std::uint32_t rawMask = sampleRawKeyMask();
  const std::uint32_t nowUs = micros();
  const std::uint32_t nowMs = millis();

  bool pending = false;
  bool wakeup = false;
  std::array<std::uint8_t, k18::kInputPayloadBytes> payload{};

  const std::uint32_t irqState = save_and_disable_interrupts();
  engine.pollKeys(rawMask, nowUs, nowMs);
  engine.tick(nowMs);
  pending = engine.hasPendingInputReport();
  if (pending) {
    wakeup = engine.hasPendingWakeupPress();
    engine.prepareInputReport(payload);
  }
  restore_interrupts(irqState);

  if (!pending) return;

  if (wakeup && TinyUSBDevice.suspended()) {
    TinyUSBDevice.remoteWakeup();
  }

  if (usbHid.ready() &&
      usbHid.sendReport(k18::kReportIdInput, payload.data(), payload.size())) {
    const std::uint32_t commitIrq = save_and_disable_interrupts();
    engine.commitInputReportSent();
    restore_interrupts(commitIrq);
  }
}

}  // namespace

void setup() {
  configureKeyPins();
  engine.reset(micros(), millis());
  configureUsb();

  const bool oledReady = oled.begin(engine.contrastByte());
  const std::uint32_t irqState = save_and_disable_interrupts();
  engine.setOledOnline(oledReady);
  restore_interrupts(irqState);

  // Feed only after each full main-loop pass, never from USB interrupts.
  rp2040.wdt_begin(kWatchdogTimeoutMs);
}

void loop() {
  pollAndSendKeys();
  oled.service(engine);
  rp2040.wdt_reset();
}
