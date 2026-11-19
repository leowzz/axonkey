#include "ch552.h"
#include "g17_engine.h"
#include "hw_scan.h"
#include "usb_hid.h"

static G17Engine s_engine;
static volatile uint32_t s_millis = 0UL;

/* Timer0 1ms system tick at 24MHz (Fsys / 12 = 2MHz -> 2000 ticks = 1ms) */
void timer0_isr(void) __interrupt(1) {
    TL0 = (uint8_t)((65536UL - 2000UL) & 0xFFU);
    TH0 = (uint8_t)((65536UL - 2000UL) >> 8);
    s_millis++;
}

static uint32_t millis_now(void) {
    uint32_t v;
    ET0 = 0;
    v = s_millis;
    ET0 = 1;
    return v;
}

static void init_timer0(void) {
    TMOD = (uint8_t)((TMOD & 0xF0U) | 0x01U);
    TL0 = (uint8_t)((65536UL - 2000UL) & 0xFFU);
    TH0 = (uint8_t)((65536UL - 2000UL) >> 8);
    TF0 = 0;
    ET0 = 1;
    TR0 = 1;
}

void main(void) {
    uint16_t touch_raw[G17_TOUCH_CHANNELS];
    uint32_t led_guard_until_ms = 0UL;

    hw_init_gpio_and_clock();
    g17_engine_init(&s_engine);
    init_timer0();
    usb_hid_init(&s_engine);
    EA = 1;

    while (1) {
        uint32_t now = millis_now();
        uint32_t raw_matrix;
        uint8_t led_busy;

        WDOG_COUNT = 0x00U; /* Feed watchdog */

        /* 1. Scan 5x4 mechanical matrix (+ idle-GND switches) */
        raw_matrix = hw_scan_matrix_20();
        hw_get_matrix_diag(&s_engine.diag_idle_p3, s_engine.diag_drv_p3);
        s_engine.diag_touch_chg_skips = hw_get_touch_chg_skips();
        g17_engine_poll_matrix(&s_engine, raw_matrix, now);

        /* 2. Poll 4-chevron capacitive touch slider (skip during/just after WS2812 TX) */
        led_busy = ((int32_t)(led_guard_until_ms - now) > 0) ? 1U : 0U;
        if (hw_poll_touch_4ch(touch_raw) != 0U) {
            g17_engine_feed_touch(&s_engine, touch_raw, led_busy, now);
        }

        /* 3. Advance gesture pulses & send HID report on change */
        g17_engine_tick(&s_engine, now);
        if (usb_hid_ep1_ready() != 0U && g17_engine_has_pending_input(&s_engine) != 0U) {
            uint8_t report[8];
            g17_engine_build_input_report(&s_engine, report);
            usb_hid_send_input_report(report);
        }

        /* 4. Refresh WS2812 RGB strip only when dirty (after initial USB settle),
         *    guarding TouchKey against crosstalk. */
        if (s_engine.led.dirty != 0U && (usb_hid_is_configured() != 0U || now >= 200UL)) {
            uint8_t bri = ((s_engine.flags & G17_FLAG_USB_SUSPENDED) != 0U || s_engine.led.mode == 0U)
                              ? 0U
                              : s_engine.led.brightness;
            hw_ws2812_show_solid(s_engine.led.r, s_engine.led.g, s_engine.led.b, bri);
            s_engine.led.dirty = 0U;
            led_guard_until_ms = millis_now() + 3UL;
        }
    }
}
