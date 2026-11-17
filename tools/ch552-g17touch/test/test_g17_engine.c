#include "../lib/g17_core/g17_engine.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void feed_idle_calibration(G17Engine *eng, uint32_t *now_ms) {
    const uint16_t idle[G17_TOUCH_CHANNELS] = {6200U, 6200U, 6200U, 6200U};
    uint8_t i;
    for (i = 0U; i < G17_TOUCH_CAL_SAMPLES; ++i) {
        g17_engine_feed_touch(eng, idle, 0U, *now_ms);
        *now_ms += 5U;
    }
    assert(eng->touch_calibrated == 1U);
    assert(eng->touch_baseline[0] == 6200U);
    assert(eng->touch_baseline[3] == 6200U);
}

static void test_matrix_nkro_and_debounce(void) {
    G17Engine eng;
    uint32_t now = 100U;
    uint8_t rep[8];
    g17_engine_init(&eng);

    /* Simultaneous chord: slot 0 -> Num(0), slot 16 -> Enter(14), slot 23 -> 5(9) */
    g17_engine_poll_matrix(&eng, (1UL << 0) | (1UL << 16) | (1UL << 23), now);
    g17_engine_tick(&eng, now);
    assert(g17_engine_has_pending_input(&eng) == 1U);
    g17_engine_build_input_report(&eng, rep);
    assert(rep[0] == G17_INPUT_REPORT_ID);
    assert(rep[1] == (1U << 0));
    assert(rep[2] == ((1U << 1) | (1U << 6))); /* bit 9 (5) + bit 14 (Enter) */

    /* Release key 0 for 5ms (< 10ms debounce): still held */
    now += 5U;
    g17_engine_poll_matrix(&eng, (1UL << 16) | (1UL << 23), now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << 0)) != 0UL);

    /* Steady release >= 10ms: releases cleanly while keys 5 & Enter remain pressed */
    now += 10U;
    g17_engine_poll_matrix(&eng, (1UL << 16) | (1UL << 23), now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << 0)) == 0UL);
    assert((eng.logical_bitmap & (1UL << 9)) != 0UL);
    assert((eng.logical_bitmap & (1UL << 14)) != 0UL);
}

static void feed_touch_frames(G17Engine *eng, const uint16_t counts[4], uint8_t n, uint32_t *now) {
    for (uint8_t i = 0U; i < n; ++i) {
        g17_engine_feed_touch(eng, counts, 0U, *now);
        g17_engine_tick(eng, *now);
        *now += 8U;
    }
}

static void test_touch_tap_and_hold_disambiguation(void) {
    G17Engine eng;
    uint32_t now = 0U;
    const uint16_t idle[4] = {6200U, 6200U, 6200U, 6200U};
    const uint16_t glitch[4] = {6200U, 3500U, 6200U, 6200U};
    const uint16_t touch_t2[4] = {6200U, 3500U, 6200U, 6200U};

    g17_engine_init(&eng);
    feed_idle_calibration(&eng, &now);

    /* Single-frame spike must NOT arm touch or fire a spurious flash */
    g17_engine_feed_touch(&eng, glitch, 0U, now);
    now += 8U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    now += 20U;
    g17_engine_feed_touch(&eng, idle, 0U, now);
    g17_engine_tick(&eng, now);
    assert(eng.touch_active == 0U);
    assert((eng.logical_bitmap >> G17_BIT_TOUCH_BASE) == 0UL);

    /* Quick tap on zone T2 (index 1, < 200ms): contact bit is 1, zone/swipe bits stay 0 until lift */
    feed_idle_calibration(&eng, &now);
    feed_touch_frames(&eng, touch_t2, 3U, &now);
    g17_engine_tick(&eng, now);
    assert(eng.touch_active == 1U);
    assert((eng.logical_bitmap & (1UL << G17_BIT_TOUCH_CONTACT)) != 0UL);
    assert((eng.logical_bitmap & (0x3FUL << G17_BIT_TOUCH_BASE)) == 0UL);

    now += 40U;
    g17_engine_feed_touch(&eng, touch_t2, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (0x3FUL << G17_BIT_TOUCH_BASE)) == 0UL);

    /* Lift finger + 24ms release guard (4 * 8ms = 32ms -> pulse active, contact cleared) */
    feed_touch_frames(&eng, idle, 4U, &now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << G17_BIT_TOUCH_CONTACT)) == 0UL);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 1U))) != 0UL);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_UP)) == 0UL);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_DOWN)) == 0UL);

    /* Pulse turns off after G17_PULSE_ON_MS */
    now += G17_PULSE_ON_MS + 2U;
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap >> G17_BIT_TOUCH_BASE) == 0UL);

    /* Long press / hold on zone T4 (index 3, >= 200ms): commits continuous hold */
    const uint16_t touch_t4[4] = {6200U, 6200U, 6200U, 3500U};
    feed_touch_frames(&eng, touch_t4, 3U, &now);
    now += G17_TOUCH_HOLD_COMMIT_MS + 5U;
    g17_engine_feed_touch(&eng, touch_t4, 0U, now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 3U))) != 0UL);
    assert(eng.slider_pos == 1000U);

    /* Pause >= 200ms in HOLDING, then slide upward -> MUST smoothly unlock into SWIPING! */
    const uint16_t slide_t3[4] = {6200U, 6200U, 3500U, 5200U};
    feed_touch_frames(&eng, slide_t3, 3U, &now);
    g17_engine_tick(&eng, now);
    assert(eng.touch_state == G17_TOUCH_SWIPING);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 3U))) == 0UL);

    /* Release ends touch */
    feed_touch_frames(&eng, idle, 6U, &now);
    g17_engine_tick(&eng, now);
    assert((eng.logical_bitmap & (1UL << G17_BIT_TOUCH_CONTACT)) == 0UL);
}

static void test_touch_slider_swipe_up_and_down(void) {
    G17Engine eng;
    uint32_t now = 0U;
    uint8_t rep[8];
    const uint16_t idle[4] = {6200U, 6200U, 6200U, 6200U};
    /* Start near bottom (T4=1000), slide smoothly upward across gap to top (T1=0) */
    const uint16_t p_bot[4] = {6200U, 6200U, 6200U, 3200U};
    const uint16_t p_mid_low[4] = {6200U, 6200U, 3200U, 4600U};
    /* Real hardware inter-chevron gap from capture (drops = 30, 34 -> sum 64 >= 42) */
    const uint16_t p_gap[4] = {6200U, 6170U, 6166U, 6200U};
    const uint16_t p_mid_hi[4] = {6200U, 3200U, 4600U, 6200U};
    const uint16_t p_top[4] = {3200U, 6200U, 6200U, 6200U};
    /* Light finger-lift tail (drops = 25, 25 -> sum 50, below press_thresh) */
    const uint16_t p_lift_tail[4] = {6175U, 6175U, 6200U, 6200U};

    g17_engine_init(&eng);
    feed_idle_calibration(&eng, &now);

    feed_touch_frames(&eng, p_bot, 3U, &now);
    g17_engine_feed_touch(&eng, p_mid_low, 0U, now);
    g17_engine_tick(&eng, now);

    /* Must enter SWIPING and emit SWIPE_UP without firing T4 tap */
    assert(eng.touch_state == G17_TOUCH_SWIPING);
    assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_UP)) != 0UL);
    assert((eng.logical_bitmap & (1UL << (G17_BIT_TOUCH_BASE + 3U))) == 0UL);

    /* Crossing low-signal gap (sum=64) must keep touch_active == 1 continuously */
    feed_touch_frames(&eng, p_gap, 3U, &now);
    assert(eng.touch_active == 1U);
    assert(eng.touch_state == G17_TOUCH_SWIPING);

    /* Continue sliding up -> must observe SWIPE_UP and linear slider_pos -> 0 */
    uint8_t seen_up = 0U;
    uint8_t seen_down = 0U;
    for (uint8_t s = 0U; s < 8U; ++s) {
        g17_engine_feed_touch(&eng, (s < 4U) ? p_mid_hi : p_top, 0U, now);
        g17_engine_tick(&eng, now);
        if ((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_UP)) != 0UL) {
            seen_up = 1U;
        }
        now += 8U;
    }
    assert(seen_up == 1U);
    assert(eng.slider_pos < 50U);

    /* Reverse direction on same touch -> must immediately cancel UP & observe SWIPE_DOWN */
    for (uint8_t s = 0U; s < 6U; ++s) {
        g17_engine_feed_touch(&eng, p_mid_hi, 0U, now);
        g17_engine_tick(&eng, now);
        if ((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_DOWN)) != 0UL) {
            seen_down = 1U;
            assert((eng.logical_bitmap & (1UL << G17_BIT_SWIPE_UP)) == 0UL);
        }
        now += 8U;
    }
    assert(seen_down == 1U);

    /* Pre-lift freeze: light lift tail preserves exact pre-lift slider_pos in rep[6..7] */
    uint16_t pre_lift_pos = eng.slider_pos;
    assert(pre_lift_pos >= 300U && pre_lift_pos <= 600U);
    g17_engine_feed_touch(&eng, p_lift_tail, 0U, now);
    g17_engine_tick(&eng, now);
    assert(eng.slider_pos == pre_lift_pos);

    /* Release does NOT emit a spurious zone tap and preserves final slider_pos on release packet */
    feed_touch_frames(&eng, idle, 6U, &now);
    g17_engine_build_input_report(&eng, rep);
    assert(((uint16_t)rep[6] | ((uint16_t)rep[7] << 8)) == pre_lift_pos);
    assert((rep[4] & (1U << (G17_BIT_TOUCH_CONTACT - 24U))) == 0U);
    for (uint8_t step = 0U; step < 6U; ++step) {
        now += G17_PULSE_ON_MS + 2U;
        g17_engine_tick(&eng, now);
        assert((eng.logical_bitmap & (0x0FUL << G17_BIT_TOUCH_BASE)) == 0UL);
    }
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
    g17_engine_poll_matrix(&eng, (1UL << 5), now + 20U);
    g17_engine_tick(&eng, now + 20U);
    assert((eng.logical_bitmap & (1UL << 4)) != 0UL);

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
