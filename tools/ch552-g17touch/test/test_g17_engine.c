#include "../lib/g17_core/g17_engine.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void feed_idle_calibration(G17Engine *eng, uint32_t *now_ms) {
    const uint16_t idle[G17_TOUCH_CHANNELS] = {1000U, 1000U, 1000U, 1000U};
    uint8_t i;
    for (i = 0U; i < G17_TOUCH_CAL_SAMPLES; ++i) {
        g17_engine_feed_touch(eng, idle, 0U, *now_ms);
        *now_ms += 5U;
    }
    assert(eng->touch_calibrated == 1U);
    assert(eng->touch_baseline[0] == 1000U);
    assert(eng->touch_baseline[3] == 1000U);
}

static void test_matrix_nkro_and_debounce(void) {
    G17Engine eng;
    uint32_t now = 100U;
    uint8_t rep[8];
    g17_engine_init(&eng);

    /* Simultaneous 3-key chord: zero-latency press */
    g17_engine_poll_matrix(&eng, (1UL << 0) | (1UL << 5) | (1UL << 16), now);
    g17_engine_tick(&eng, now);
    assert(g17_engine_has_pending_input(&eng) == 1U);
    g17_engine_build_input_report(&eng, rep);
    assert(rep[0] == G17_INPUT_REPORT_ID);
    assert(rep[1] == ((1U << 0) | (1U << 5)));
    assert(rep[3] == (1U << 0)); /* bit 16 -> b2 bit 0 */

    /* Release key 0 for 5ms (< 10ms debounce): still held */
    now += 5U;
    g17_engine_poll_matrix(&eng, (1UL << 5) | (1UL << 16), now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << 0)) != 0UL);

    /* Steady release >= 10ms: releases cleanly while keys 5 & 16 remain pressed */
    now += 10U;
    g17_engine_poll_matrix(&eng, (1UL << 5) | (1UL << 16), now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << 0)) == 0UL);
    assert((eng.logical_bitmap & (1UL << 5)) != 0UL);
    assert((eng.logical_bitmap & (1UL << 16)) != 0UL);
}

static void test_touch_tap_and_hold_disambiguation(void) {
    G17Engine eng;
    uint32_t now = 0U;
    const uint16_t idle[4] = {1000U, 1000U, 1000U, 1000U};
    const uint16_t touch_t2[4] = {1000U, 880U, 1000U, 1000U};

    g17_engine_init(&eng);
    feed_idle_calibration(&eng, &now);

    /* Quick tap on zone T2 (index 1, < 180ms): fires pulse ONLY after lift */
    g17_engine_feed_touch(&eng, touch_t2, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap >> G17_BIT_TOUCH_BASE) == 0UL);

    now += 60U;
    g17_engine_feed_touch(&eng, touch_t2, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap >> G17_BIT_TOUCH_BASE) == 0UL);

    /* Lift finger + 12ms release guard */
    now += 10U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    now += 15U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 1U))) != 0UL);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_UP)) == 0UL);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_DOWN)) == 0UL);

    /* Pulse turns off after G17_PULSE_ON_MS */
    now += G17_PULSE_ON_MS + 2U;
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap >> G17_BIT_TOUCH_BASE) == 0UL);

    /* Long press / hold on zone T4 (index 3, >= 180ms): commits continuous hold */
    const uint16_t touch_t4[4] = {1000U, 1000U, 1000U, 870U};
    g17_engine_feed_touch(&eng, touch_t4, 0U, now);
    now += G17_TOUCH_HOLD_COMMIT_MS + 5U;
    g17_engine_feed_touch(&eng, touch_t4, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 3U))) != 0UL);

    /* Release ends hold */
    now += 20U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    now += 15U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 3U))) == 0UL);
}

static void test_touch_slider_swipe_up_and_down(void) {
    G17Engine eng;
    uint32_t now = 0U;
    const uint16_t idle[4] = {1000U, 1000U, 1000U, 1000U};
    /* Start near bottom (T4=300), slide smoothly upward to top (T1=0) */
    const uint16_t p_bot[4] = {1000U, 1000U, 1000U, 850U};
    const uint16_t p_mid_low[4] = {1000U, 1000U, 880U, 920U};
    const uint16_t p_mid_hi[4] = {1000U, 880U, 920U, 1000U};
    const uint16_t p_top[4] = {850U, 1000U, 1000U, 1000U};

    g17_engine_init(&eng);
    feed_idle_calibration(&eng, &now);

    g17_engine_feed_touch(&eng, p_bot, 0U, now);
    now += 20U;
    g17_engine_feed_touch(&eng, p_mid_low, 0U, now);
    g17_engine_tick(&eng, now);

    /* Must enter SWIPING and emit SWIPE_UP without firing T4 tap */
    assert(eng.touch_state == G17_TOUCH_SWIPING);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_UP)) != 0UL);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 3U))) == 0UL);

    /* Finish first pulse, continue sliding up */
    now += G17_PULSE_ON_MS + 2U;
    g17_engine_tick(&eng, now);
    now += G17_PULSE_GAP_MS + 2U;
    g17_engine_feed_touch(&eng, p_mid_hi, 0U, now);
    g17_engine_tick(&eng, now);
    now += G17_PULSE_ON_MS + 2U;
    g17_engine_tick(&eng, now);
    now += G17_PULSE_GAP_MS + 2U;
    g17_engine_feed_touch(&eng, p_top, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_UP)) != 0UL);

    /* Reverse direction on same touch -> emits SWIPE_DOWN */
    now += G17_PULSE_ON_MS + 2U;
    g17_engine_tick(&eng, now);
    now += G17_PULSE_GAP_MS + 2U;
    g17_engine_feed_touch(&eng, p_mid_hi, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_DOWN)) != 0UL);

    /* Release does NOT emit a spurious zone tap after swiping */
    now += 15U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    now += 15U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    for (uint8_t step = 0U; step < 8U; ++step) {
        now += G17_PULSE_ON_MS + 2U;
        g17_engine_tick(&eng, now);
        assert((eng.logical_bitmap & (0x0FUL << G17_BIT_TOUCH_BASE)) == 0UL);
        now += G17_PULSE_GAP_MS + 2U;
        g17_engine_tick(&eng, now);
        assert((eng.logical_bitmap & (0x0FUL << G17_BIT_TOUCH_BASE)) == 0UL);
    }
    assert((eng.logical_bitmap >> G17_BIT_TOUCH_BASE) == 0UL);
}

static void test_led_crosstalk_and_no_sleep_on_suspend(void) {
    G17Engine eng;
    uint32_t now = 0U;
    const uint16_t noisy_led[4] = {600U, 600U, 600U, 600U};
    uint8_t out_pkt[64];

    g17_engine_init(&eng);
    feed_idle_calibration(&eng, &now);

    /* Sample taken while WS2812 LEDs are refreshing must be discarded */
    g17_engine_feed_touch(&eng, noisy_led, 1U, now);
    g17_engine_tick(&eng, now);
    assert(eng.touch_active == 0U);
    assert((eng.flags & G17_FLAG_TOUCH_ACTIVE) == 0U);

    /* USB Suspend sets flag and marks LEDs dirty (to dim), while keys still work */
    g17_engine_set_usb_suspended(&eng, 1U);
    assert((eng.flags & G17_FLAG_USB_SUSPENDED) != 0U);
    assert(eng.led.dirty == 1U);
    g17_engine_poll_matrix(&eng, (1UL << 2), now + 20U);
    g17_engine_tick(&eng, now + 20U);
    assert((eng.logical_bitmap & (1UL << 2)) != 0UL);

    /* Output report updates LED color and touch sensitivity */
    memset(out_pkt, 0, sizeof(out_pkt));
    out_pkt[0] = G17_OUTPUT_REPORT_ID;
    out_pkt[1] = 0x01U;
    out_pkt[2] = 1U;
    out_pkt[3] = 255U;
    out_pkt[4] = 80U;
    out_pkt[5] = 0U;
    out_pkt[6] = 90U;
    g17_engine_handle_output_report(&eng, out_pkt, 7U);
    assert(eng.led.r == 255U && eng.led.brightness == 90U);
    assert((eng.flags & G17_FLAG_LED_HOST_CTRL) != 0U);
}

int main(void) {
    test_matrix_nkro_and_debounce();
    test_touch_tap_and_hold_disambiguation();
    test_touch_slider_swipe_up_and_down();
    test_led_crosstalk_and_no_sleep_on_suspend();
    printf("All g17_engine unit tests passed!\n");
    return 0;
}
