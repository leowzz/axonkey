#ifndef USB_HID_H
#define USB_HID_H

#include "g17_engine.h"
#include <stdint.h>

void usb_hid_init(G17_XDATA G17Engine *eng);
void usb_hid_isr(void) __interrupt(8);
uint8_t usb_hid_is_configured(void);
uint8_t usb_hid_ep1_ready(void);
uint8_t usb_hid_send_input_report(const uint8_t report[8]);

#endif
