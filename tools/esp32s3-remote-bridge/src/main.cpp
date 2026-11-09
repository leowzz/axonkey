#include <Arduino.h>
#include <NimBLEDevice.h>
#include <USB.h>
#include <USBCDC.h>
#include <USBHID.h>

namespace {

const NimBLEAddress remoteAddress("0c:f3:ce:78:65:6b", BLE_ADDR_PUBLIC);
constexpr uint8_t reportSizes[] = {8, 4, 2};

// The first three collections from YYYKQ's HID Report Map. Its private reports
// use IDs 0xf8–0xfc and are outside the keyboard, mouse and consumer bridge.
constexpr uint8_t reportDescriptor[] = {
    // Report 1: keyboard.
    0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, 0x01, 0x05, 0x07, 0x19, 0xe0,
    0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
    0x95, 0x01, 0x75, 0x08, 0x81, 0x01, 0x95, 0x05, 0x75, 0x01, 0x05, 0x08,
    0x19, 0x01, 0x29, 0x05, 0x91, 0x02, 0x95, 0x01, 0x75, 0x03, 0x91, 0x01,
    0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0xff, 0x05, 0x07, 0x19, 0x00,
    0x29, 0xff, 0x81, 0x00, 0xc0,
    // Report 2: mouse.
    0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x85, 0x02, 0x09, 0x01, 0xa1, 0x00,
    0x05, 0x09, 0x19, 0x01, 0x29, 0x03, 0x15, 0x00, 0x25, 0x01, 0x95, 0x03,
    0x75, 0x01, 0x81, 0x02, 0x95, 0x01, 0x75, 0x05, 0x81, 0x01, 0x05, 0x01,
    0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08,
    0x95, 0x03, 0x81, 0x06, 0xc0, 0xc0,
    // Report 3: consumer control.
    0x05, 0x0c, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x03, 0x19, 0x00, 0x2a, 0x9c,
    0x02, 0x15, 0x00, 0x26, 0x9c, 0x02, 0x95, 0x01, 0x75, 0x10, 0x81, 0x00, 0xc0,
};

class RemoteHid : public USBHIDDevice {
public:
    RemoteHid() {
        USBHID::addDevice(this, sizeof(reportDescriptor));
    }

    uint16_t _onGetDescriptor(uint8_t *buffer) override {
        memcpy(buffer, reportDescriptor, sizeof(reportDescriptor));
        return sizeof(reportDescriptor);
    }

    USBHID hid;
};

struct Report {
    uint8_t id;
    uint8_t data[8];
};

RemoteHid usbRemote;
USBCDC usbSerial;
SemaphoreHandle_t remoteFound;
QueueHandle_t reports;
NimBLEClient *client;

class RemoteScan : public NimBLEScanCallbacks {
    void onResult(const NimBLEAdvertisedDevice *device) override {
        if (device->getAddress() == remoteAddress && device->isConnectable()) {
            NimBLEDevice::getScan()->stop();
            xSemaphoreGive(remoteFound);
        }
    }
};

RemoteScan remoteScan;

class RemoteConnection : public NimBLEClientCallbacks {
    void onDisconnect(NimBLEClient *, int reason) override {
        usbSerial.printf("DISCONNECTED reason=0x%x\n", reason);
    }
};

RemoteConnection remoteConnection;

bool subscribeReports(NimBLERemoteService &service) {
    unsigned subscribed = 0;
    for (auto *characteristic : service.getCharacteristics(true)) {
        if (characteristic->getUUID() != NimBLEUUID(uint16_t{0x2a4d}) || !characteristic->canNotify()) {
            continue;
        }
        auto *descriptor = characteristic->getDescriptor(NimBLEUUID(uint16_t{0x2908}));
        if (!descriptor) {
            continue;
        }
        const auto reference = descriptor->readValue();
        if (reference.size() != 2 || reference.data()[1] != 1) {
            continue;
        }
        const uint8_t id = reference.data()[0];
        if (id < 1 || id > sizeof(reportSizes)) {
            continue;
        }
        const bool ok = characteristic->subscribe(true,
            [id](NimBLERemoteCharacteristic *, uint8_t *bytes, size_t length, bool) {
                if (length != reportSizes[id - 1]) {
                    return;
                }
                Report report = {id, {}};
                memcpy(report.data, bytes, length);
                xQueueSend(reports, &report, 0);
            });
        if (ok) {
            subscribed |= 1u << (id - 1);
        }
        if (subscribed == 0x07) {
            break;
        }
    }
    usbSerial.printf("SUBSCRIBED reports=0x%x\n", subscribed);
    return subscribed != 0;
}

void forwardReports() {
    while (client->isConnected()) {
        Report report;
        if (xQueueReceive(reports, &report, pdMS_TO_TICKS(100)) != pdTRUE) {
            continue;
        }
        const size_t length = reportSizes[report.id - 1];
        const bool sent = usbRemote.hid.SendReport(report.id, report.data, length, 20);
        usbSerial.printf("HID id=%u usb=%u data=", report.id, sent);
        for (size_t index = 0; index < length; ++index) {
            usbSerial.printf("%02x", report.data[index]);
        }
        usbSerial.println();
    }

    // Release keys and buttons if the remote disconnects while one is down.
    const uint8_t released[8] = {};
    for (size_t index = 0; index < sizeof(reportSizes); ++index) {
        usbRemote.hid.SendReport(index + 1, released, reportSizes[index], 20);
    }
    xQueueReset(reports);
}

}  // namespace

void setup() {
    usbSerial.begin(115200);
    usbRemote.hid.begin();
    USB.productName("YYYKQ Remote Bridge");
    USB.begin();

    remoteFound = xSemaphoreCreateBinary();
    reports = xQueueCreate(16, sizeof(Report));
    if (!remoteFound || !reports || !NimBLEDevice::init("YYYKQ Remote Bridge")) {
        abort();
    }
    NimBLEDevice::setSecurityAuth(true, false, false);
    NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);
    NimBLEDevice::setSecurityInitKey(BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID);
    NimBLEDevice::setSecurityRespKey(BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID);
    client = NimBLEDevice::createClient();
    client->setClientCallbacks(&remoteConnection, false);
    client->setConnectionParams(9, 12, 0, 200);
    client->setConnectTimeout(3000);

    auto *scan = NimBLEDevice::getScan();
    scan->setScanCallbacks(&remoteScan);
    scan->setMaxResults(0);
    scan->setInterval(50);
    scan->setWindow(40);
    usbSerial.println("READY YYYKQ USB HID bridge");
}

void loop() {
    usbSerial.println("SCAN target=YYYKQ");
    if (!NimBLEDevice::getScan()->start(0)) {
        delay(500);
        return;
    }
    xSemaphoreTake(remoteFound, portMAX_DELAY);

    usbSerial.println("FOUND YYYKQ");
    if (client->connect(remoteAddress)) {
        const bool secure = client->secureConnection();
        usbSerial.printf("SECURITY ok=%u bonds=%d\n", secure, NimBLEDevice::getNumBonds());
        auto *service = secure ? client->getService(NimBLEUUID(uint16_t{0x1812})) : nullptr;
        if (service && subscribeReports(*service)) {
            forwardReports();
        } else if (client->isConnected()) {
            client->disconnect();
            while (client->isConnected()) {
                delay(25);
            }
        }
    }
    delay(300);
}
