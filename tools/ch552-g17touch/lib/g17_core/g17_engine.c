#include "g17_engine.h"
#include <string.h>

/*
 * Matrix slot -> logical key index (0..16 for K01..K17, 0xFF if unmapped).
 * Slots 0..19 are charlieplex (drv, sns) in K1..K5 order (P3.0, P3.1, P3.2, P3.4, P3.3);
 * slots 20..24 are idle-low switches on K1..K5 directly.
 * Physical numpad order (left-to-right, top-to-bottom):
 *   0: Num, 1: /, 2: *, 3: -,
 *   4: 7,   5: 8, 6: 9, 7: +,
 *   8: 4,   9: 5, 10: 6,
 *   11: 1, 12: 2, 13: 3, 14: Enter,
 *   15: 0, 16: .
 */
static uint8_t s_matrix_map[G17_MATRIX_SLOTS] = {
    /* drv=K1 (P3.0): K2, K3, K4, K5 */
    0U, 1U, 0xFFU, 2U,
    /* drv=K2 (P3.1): K1, K3(7), K4, K5(9) */
    3U, 4U, 0xFFU, 6U,
    /* drv=K3 (P3.2): K1(+), K2(1), K4, K5(3) */
    7U, 11U, 0xFFU, 13U,
    /* drv=K4 (P3.4): K1, K2, K3, K5(Enter) */
    0xFFU, 0xFFU, 0xFFU, 14U,
    /* drv=K5 (P3.3): K1, K2(0), K3(.), K4(5) */
    0xFFU, 15U, 16U, 9U,
    /* idle-low lines in K1..K5 order: K1(8), K2(4), K3(6), K4, K5(2) */
    5U, 8U, 10U, 0xFFU, 12U
};

static uint16_t abs_diff_u16(uint16_t a, uint16_t b) {
    return (a >= b) ? (a - b) : (b - a);
}

static void queue_pulse(G17Engine *eng, uint8_t idx, uint32_t now_ms) {
    if (idx >= 6U) {
        return;
    }
    if (eng->pulse_remaining[idx] < 8U) {
        eng->pulse_remaining[idx]++;
    }
    if ((eng->pulse_active & (uint8_t)(1U << idx)) == 0U &&
        (eng->pulse_in_gap & (uint8_t)(1U << idx)) == 0U) {
        eng->pulse_active |= (uint8_t)(1U << idx);
        eng->pulse_timer_ms[idx] = now_ms;
    }
}

void g17_engine_set_matrix_map(const uint8_t map[G17_MATRIX_SLOTS]) {
    uint8_t i;
    for (i = 0U; i < G17_MATRIX_SLOTS; ++i) {
        s_matrix_map[i] = map[i];
    }
}

void g17_engine_init(G17Engine *eng) {
    uint8_t i;
    memset(eng, 0, sizeof(*eng));
    for (i = 0U; i < G17_MATRIX_SLOTS; ++i) {
        eng->matrix_change_ms[i] = (uint32_t)(0UL - G17_DEBOUNCE_MS);
    }
    eng->touch_press_thresh = G17_TOUCH_DEFAULT_PRESS_THRESH;
    eng->touch_release_thresh = G17_TOUCH_DEFAULT_RELEASE_THRESH;
    eng->touch_swipe_step = G17_TOUCH_DEFAULT_SWIPE_STEP;
    eng->led.mode = 1U;
    eng->led.r = 48U;
    eng->led.g = 128U;
    eng->led.b = 255U;
    eng->led.brightness = 60U;
    eng->led.dirty = 1U;
}

void g17_engine_poll_matrix(G17Engine *eng, uint32_t raw_matrix_mask, uint32_t now_ms) {
    uint8_t i;
    for (i = 0U; i < G17_MATRIX_SLOTS; ++i) {
        uint32_t bit = (uint32_t)1UL << i;
        uint8_t raw_pressed = (raw_matrix_mask & bit) != 0U;
        uint8_t stable_pressed = (eng->matrix_stable & bit) != 0U;
        uint32_t elapsed = (uint32_t)(now_ms - eng->matrix_change_ms[i]);

        if (!stable_pressed) {
            if (raw_pressed && elapsed >= G17_DEBOUNCE_MS) {
                eng->matrix_stable |= bit;
                eng->matrix_change_ms[i] = now_ms;
            }
        } else {
            if (raw_pressed) {
                /* Hold renewal prevents micro-chatter while held from releasing the key. */
                eng->matrix_change_ms[i] = now_ms;
            } else if (elapsed >= G17_DEBOUNCE_MS) {
                eng->matrix_stable &= ~bit;
                eng->matrix_change_ms[i] = now_ms;
            }
        }
    }
}

void g17_engine_feed_touch(G17Engine *eng, const uint16_t raw_counts[G17_TOUCH_CHANNELS],
                           uint8_t led_busy, uint32_t now_ms) {
    uint8_t i;
    uint16_t deltas[G17_TOUCH_CHANNELS];
    uint32_t weighted_sum = 0U;
    uint32_t delta_sum = 0U;
    uint16_t max_delta = 0U;
    uint8_t max_zone = 0U;
    uint16_t pos = 0U;
    uint8_t pressed_now;

    for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
        eng->diag_touch_raw[i] = raw_counts[i];
    }

    if (led_busy != 0U) {
        return;
    }

    if (eng->touch_calibrated == 0U) {
        for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
            eng->touch_cal_acc[i] += raw_counts[i];
        }
        eng->touch_cal_count++;
        if (eng->touch_cal_count >= G17_TOUCH_CAL_SAMPLES) {
            for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
                uint16_t base = (uint16_t)(eng->touch_cal_acc[i] / G17_TOUCH_CAL_SAMPLES);
                eng->touch_baseline[i] = base;
                eng->touch_filt[i] = base;
            }
            eng->touch_calibrated = 1U;
        }
        return;
    }

    for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
        uint16_t filt =
            (uint16_t)(((uint32_t)eng->touch_filt[i] * 3U + (uint32_t)raw_counts[i] + 2U) >> 2);
        uint16_t base = eng->touch_baseline[i];
        uint16_t d;
        eng->touch_filt[i] = filt;
        d = (base > filt) ? (uint16_t)(base - filt) : 0U;
        deltas[i] = d;
        if (d > max_delta) {
            max_delta = d;
            max_zone = i;
        }
        if (d >= (eng->touch_release_thresh / 2U)) {
            uint32_t weight = (uint32_t)d;
            weighted_sum += weight * ((uint32_t)i * 100U);
            delta_sum += weight;
        }
    }

    if (eng->touch_active != 0U) {
        pressed_now = (max_delta >= eng->touch_release_thresh) ? 1U : 0U;
    } else if (max_delta >= eng->touch_press_thresh) {
        if (eng->touch_arm_hits < 255U) {
            eng->touch_arm_hits++;
        }
        pressed_now = (eng->touch_arm_hits >= G17_TOUCH_ARM_CONFIRM_FRAMES) ? 1U : 0U;
    } else {
        eng->touch_arm_hits = 0U;
        pressed_now = 0U;
    }

    if (pressed_now != 0U) {
        eng->touch_release_guard_ms = now_ms;
        if (delta_sum > 0U) {
            pos = (uint16_t)(weighted_sum / delta_sum);
        } else {
            pos = (uint16_t)max_zone * 100U;
        }

        if (eng->touch_active == 0U) {
            eng->touch_active = 1U;
            eng->touch_state = G17_TOUCH_ARMED;
            eng->touch_start_zone = max_zone;
            eng->touch_start_pos = pos;
            eng->touch_anchor_pos = pos;
            eng->touch_arm_ms = now_ms;
        } else if (eng->touch_state == G17_TOUCH_ARMED) {
            if (abs_diff_u16(pos, eng->touch_start_pos) >= G17_TOUCH_SLIDE_ENTER_DELTA) {
                eng->touch_state = G17_TOUCH_SWIPING;
                /* Emit immediate first step in the initial slide direction. */
                if (pos < eng->touch_start_pos) {
                    queue_pulse(eng, 4U, now_ms); /* SWIPE_UP */
                } else {
                    queue_pulse(eng, 5U, now_ms); /* SWIPE_DOWN */
                }
                eng->touch_anchor_pos = pos;
            } else if ((uint32_t)(now_ms - eng->touch_arm_ms) >= G17_TOUCH_HOLD_COMMIT_MS) {
                eng->touch_state = G17_TOUCH_HOLDING;
            }
        } else if (eng->touch_state == G17_TOUCH_SWIPING) {
            while (pos + eng->touch_swipe_step <= eng->touch_anchor_pos) {
                queue_pulse(eng, 4U, now_ms); /* SWIPE_UP */
                eng->touch_anchor_pos -= eng->touch_swipe_step;
            }
            while (pos >= eng->touch_anchor_pos + eng->touch_swipe_step) {
                queue_pulse(eng, 5U, now_ms); /* SWIPE_DOWN */
                eng->touch_anchor_pos += eng->touch_swipe_step;
            }
        }
    } else {
        if (eng->touch_active != 0U) {
            /* Short release debounce (12ms) prevents finger-lift jitter from duplicating taps. */
            if ((uint32_t)(now_ms - eng->touch_release_guard_ms) >= 12U) {
                if (eng->touch_state == G17_TOUCH_ARMED) {
                    queue_pulse(eng, eng->touch_start_zone, now_ms);
                }
                eng->touch_active = 0U;
                eng->touch_state = G17_TOUCH_IDLE;
            }
        } else {
            /* Idle: slowly track environmental capacitance drift (frozen during touch). */
            eng->touch_drift_div++;
            if (eng->touch_drift_div >= 8U) {
                eng->touch_drift_div = 0U;
                for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
                    if (raw_counts[i] > eng->touch_baseline[i]) {
                        eng->touch_baseline[i]++;
                    } else if (raw_counts[i] + (eng->touch_release_thresh / 2U) <
                               eng->touch_baseline[i]) {
                        /* Only drift down when well below touch threshold (or gentle drift). */
                        eng->touch_baseline[i]--;
                    } else if (raw_counts[i] < eng->touch_baseline[i] &&
                               deltas[i] < (eng->touch_release_thresh / 2U)) {
                        eng->touch_baseline[i]--;
                    }
                }
            }
        }
    }

    if (eng->touch_active != 0U) {
        eng->flags |= G17_FLAG_TOUCH_ACTIVE;
    } else {
        eng->flags &= (uint8_t)~G17_FLAG_TOUCH_ACTIVE;
    }
}

void g17_engine_tick(G17Engine *eng, uint32_t now_ms) {
    uint8_t i;
    uint32_t next_bitmap = 0U;

    /* 1. Map stable mechanical matrix bits through s_matrix_map */
    for (i = 0U; i < G17_MATRIX_SLOTS; ++i) {
        if ((eng->matrix_stable & ((uint32_t)1UL << i)) != 0U) {
            uint8_t logical = s_matrix_map[i];
            if (logical < G17_BIT_TOUCH_BASE) {
                next_bitmap |= ((uint32_t)1UL << logical);
            }
        }
    }

    /* 2. Continuous zone hold when in G17_TOUCH_HOLDING */
    if (eng->touch_active != 0U && eng->touch_state == G17_TOUCH_HOLDING &&
        eng->touch_start_zone < G17_TOUCH_CHANNELS) {
        next_bitmap |= ((uint32_t)1UL << (G17_BIT_TOUCH_BASE + eng->touch_start_zone));
    }

    /* 3. Advance discrete pulse timers (T1..T4 short tap + SWIPE_UP / SWIPE_DOWN) */
    for (i = 0U; i < 6U; ++i) {
        uint8_t mask = (uint8_t)(1U << i);
        if ((eng->pulse_active & mask) != 0U) {
            if ((uint32_t)(now_ms - eng->pulse_timer_ms[i]) >= G17_PULSE_ON_MS) {
                eng->pulse_active &= (uint8_t)~mask;
                if (eng->pulse_remaining[i] > 0U) {
                    eng->pulse_remaining[i]--;
                }
                if (eng->pulse_remaining[i] > 0U) {
                    eng->pulse_in_gap |= mask;
                    eng->pulse_timer_ms[i] = now_ms;
                }
            } else {
                next_bitmap |= ((uint32_t)1UL << (G17_BIT_TOUCH_BASE + i));
            }
        } else if ((eng->pulse_in_gap & mask) != 0U) {
            if ((uint32_t)(now_ms - eng->pulse_timer_ms[i]) >= G17_PULSE_GAP_MS) {
                eng->pulse_in_gap &= (uint8_t)~mask;
                if (eng->pulse_remaining[i] > 0U) {
                    eng->pulse_active |= mask;
                    eng->pulse_timer_ms[i] = now_ms;
                    next_bitmap |= ((uint32_t)1UL << (G17_BIT_TOUCH_BASE + i));
                }
            }
        }
    }

    eng->logical_bitmap = next_bitmap;
    if (eng->logical_bitmap != eng->last_sent_bitmap ||
        eng->flags != eng->last_sent_flags) {
        eng->report_pending = 1U;
    }
}

void g17_engine_set_usb_suspended(G17Engine *eng, uint8_t suspended) {
    uint8_t next_flags = eng->flags;
    if (suspended != 0U) {
        next_flags |= G17_FLAG_USB_SUSPENDED;
    } else {
        next_flags &= (uint8_t)~G17_FLAG_USB_SUSPENDED;
    }
    if (next_flags != eng->flags) {
        eng->flags = next_flags;
        eng->led.dirty = 1U;
        eng->report_pending = 1U;
    }
}

uint8_t g17_engine_has_pending_input(const G17Engine *eng) {
    return eng->report_pending;
}

void g17_engine_build_input_report(G17Engine *eng, uint8_t out_buf[8]) {
    uint32_t bm = eng->logical_bitmap;
    eng->seq++;
    out_buf[0] = G17_INPUT_REPORT_ID;
    out_buf[1] = (uint8_t)(bm & 0xFFU);
    out_buf[2] = (uint8_t)((bm >> 8) & 0xFFU);
    out_buf[3] = (uint8_t)((bm >> 16) & 0xFFU);
    out_buf[4] = (uint8_t)((bm >> 24) & 0xFFU);
    out_buf[5] = eng->flags;
    out_buf[6] = eng->seq;
    out_buf[7] = 0U;

    eng->last_sent_bitmap = bm;
    eng->last_sent_flags = eng->flags;
    eng->report_pending = 0U;
}

void g17_engine_build_caps_feature(const G17Engine *eng, uint8_t out_buf[16]) {
    memset(out_buf, 0, 16U);
    out_buf[0] = G17_FEATURE_CAPS_ID;
    out_buf[1] = 1U;                        /* protocol version */
    out_buf[2] = G17_MECH_KEY_COUNT + 6U;   /* 17 mech + 4 touch zones + 2 swipe */
    out_buf[3] = 0x02U;                     /* caps: bit1 = RGB LED */
    out_buf[4] = (uint8_t)(eng->touch_press_thresh & 0xFFU);
    out_buf[5] = (uint8_t)(eng->touch_swipe_step & 0xFFU);
    out_buf[6] = eng->led.brightness;
    out_buf[7] = eng->flags;
}

void g17_engine_build_state_feature(const G17Engine *eng, uint8_t out_buf[8]) {
    uint32_t bm = eng->logical_bitmap;
    out_buf[0] = G17_FEATURE_STATE_ID;
    out_buf[1] = (uint8_t)(bm & 0xFFU);
    out_buf[2] = (uint8_t)((bm >> 8) & 0xFFU);
    out_buf[3] = (uint8_t)((bm >> 16) & 0xFFU);
    out_buf[4] = (uint8_t)((bm >> 24) & 0xFFU);
    out_buf[5] = eng->flags;
    out_buf[6] = eng->seq;
    out_buf[7] = 0U;
}

void g17_engine_build_diag_feature(const G17Engine *eng, uint8_t out_buf[32]) {
    uint8_t i;
    memset(out_buf, 0, 32U);
    out_buf[0] = G17_FEATURE_DIAG_ID;
    out_buf[1] = eng->diag_idle_p3;
    for (i = 0U; i < 5U; ++i) {
        out_buf[2U + i] = eng->diag_drv_p3[i];
    }
    out_buf[7] = (uint8_t)(eng->matrix_stable & 0xFFU);
    out_buf[8] = (uint8_t)((eng->matrix_stable >> 8) & 0xFFU);
    out_buf[9] = (uint8_t)((eng->matrix_stable >> 16) & 0xFFU);
    out_buf[10] = (uint8_t)((eng->matrix_stable >> 24) & 0xFFU);
    for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
        out_buf[11U + i * 2U] = (uint8_t)(eng->diag_touch_raw[i] & 0xFFU);
        out_buf[12U + i * 2U] = (uint8_t)((eng->diag_touch_raw[i] >> 8) & 0xFFU);
        out_buf[19U + i * 2U] = (uint8_t)(eng->touch_baseline[i] & 0xFFU);
        out_buf[20U + i * 2U] = (uint8_t)((eng->touch_baseline[i] >> 8) & 0xFFU);
    }
    out_buf[27] = eng->diag_touch_chg_skips;
    out_buf[28] = (uint8_t)eng->touch_state;
    out_buf[29] = eng->flags;
    out_buf[30] = eng->seq;
    out_buf[31] = eng->touch_calibrated;
}

void g17_engine_handle_output_report(G17Engine *eng, const uint8_t *buf, uint8_t len) {
    uint8_t op;
    if (len < 3U || buf[0] != G17_OUTPUT_REPORT_ID) {
        return;
    }
    op = buf[1];
    if (op == 0x01U && len >= 7U) {
        /* Set RGB LED config: [0x02, 0x01, mode, r, g, b, brightness] */
        eng->led.mode = buf[2];
        eng->led.r = buf[3];
        eng->led.g = buf[4];
        eng->led.b = buf[5];
        eng->led.brightness = (buf[6] > 100U) ? 100U : buf[6];
        eng->led.dirty = 1U;
        eng->flags |= G17_FLAG_LED_HOST_CTRL;
    } else if (op == 0x02U && len >= 5U) {
        /* Tune touch thresholds: [0x02, 0x02, press_thresh, release_thresh, swipe_step] */
        if (buf[2] >= 12U && buf[2] <= 200U) {
            eng->touch_press_thresh = buf[2];
        }
        if (buf[3] >= 6U && buf[3] < eng->touch_press_thresh) {
            eng->touch_release_thresh = buf[3];
        }
        if (buf[4] >= 16U && buf[4] <= 120U) {
            eng->touch_swipe_step = buf[4];
        }
    }
}
