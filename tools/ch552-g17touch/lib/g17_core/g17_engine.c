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
    /* drv=K1 (P3.0): K2(Num), K3(/), K4, K5(*) */
    0U, 1U, 0xFFU, 2U,
    /* drv=K2 (P3.1): K1(-), K3(7), K4, K5(9) */
    3U, 4U, 0xFFU, 6U,
    /* drv=K3 (P3.2): K1(+), K2(1), K4, K5(3) */
    7U, 11U, 0xFFU, 13U,
    /* drv=K4 (P3.4): unused on production PCB */
    0xFFU, 0xFFU, 0xFFU, 0xFFU,
    /* drv=K5 (P3.3): K1(Enter), K2(0), K3(.), K4 */
    14U, 15U, 16U, 0xFFU,
    /* direct switches: K1->GND(8), K2->GND(4), K3->GND(6), RST->VCC(5), K5->GND(2) */
    5U, 8U, 10U, 9U, 12U
};

static uint16_t abs_diff_u16(uint16_t a, uint16_t b) {
    return (a >= b) ? (a - b) : (b - a);
}

static void queue_pulse(G17_XDATA G17Engine *eng, uint8_t idx, uint32_t now_ms) {
    uint8_t max_q = (idx >= 4U) ? 3U : 4U;
    if (idx >= 6U) {
        return;
    }
    if (eng->pulse_remaining[idx] < max_q) {
        eng->pulse_remaining[idx]++;
    }
    if ((eng->pulse_active & (uint8_t)(1U << idx)) == 0U &&
        (eng->pulse_in_gap & (uint8_t)(1U << idx)) == 0U) {
        eng->pulse_active |= (uint8_t)(1U << idx);
        eng->pulse_timer_ms[idx] = now_ms;
    }
}

static void emit_swipe_step(G17_XDATA G17Engine *eng, uint8_t dir_up, uint32_t now_ms) {
    uint8_t idx = dir_up ? 4U : 5U;
    uint8_t other = dir_up ? 5U : 4U;
    uint8_t other_mask = (uint8_t)(1U << other);
    /* Cancel any queued opposite-direction pulses immediately on reversal. */
    eng->pulse_remaining[other] = 0U;
    eng->pulse_active &= (uint8_t)~other_mask;
    eng->pulse_in_gap &= (uint8_t)~other_mask;
    queue_pulse(eng, idx, now_ms);
}

static void step_touch_swiping(G17_XDATA G17Engine *eng, uint16_t pos, uint32_t now_ms) {
    uint16_t step = eng->touch_swipe_step;
    uint16_t anchor = eng->touch_anchor_pos;
    uint16_t extreme = eng->touch_extreme_pos;
    uint8_t dir = eng->touch_swipe_dir;

    if (dir == 1U) {
        if (pos < extreme) {
            extreme = pos;
        }
        while (pos + step <= anchor) {
            emit_swipe_step(eng, 1U, now_ms);
            anchor -= step;
        }
        if (pos >= extreme + step) {
            dir = 2U;
            anchor = extreme + step;
            extreme = pos;
            emit_swipe_step(eng, 0U, now_ms);
        }
    } else {
        if (pos > extreme) {
            extreme = pos;
        }
        while (pos >= anchor + step) {
            emit_swipe_step(eng, 0U, now_ms);
            anchor += step;
        }
        if (pos + step <= extreme) {
            dir = 1U;
            anchor = extreme - step;
            extreme = pos;
            emit_swipe_step(eng, 1U, now_ms);
        }
    }

    eng->touch_swipe_dir = dir;
    eng->touch_anchor_pos = anchor;
    eng->touch_extreme_pos = extreme;
}

void g17_engine_set_matrix_map(const uint8_t map[G17_MATRIX_SLOTS]) {
    uint8_t i;
    for (i = 0U; i < G17_MATRIX_SLOTS; ++i) {
        s_matrix_map[i] = map[i];
    }
}

void g17_engine_init(G17_XDATA G17Engine *eng) {
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

void g17_engine_poll_matrix(G17_XDATA G17Engine *eng, uint32_t raw_matrix_mask, uint32_t now_ms) {
    uint8_t i;
    uint32_t raw = raw_matrix_mask;
    uint32_t stable = eng->matrix_stable;
    uint32_t next_stable = 0UL;
    uint32_t bit = 1UL;

    for (i = 0U; i < G17_MATRIX_SLOTS; ++i) {
        uint8_t raw_pressed = (uint8_t)(raw & 1UL);
        uint8_t is_pressed = (uint8_t)(stable & 1UL);
        uint32_t elapsed = (uint32_t)(now_ms - eng->matrix_change_ms[i]);

        if (is_pressed == 0U) {
            if (raw_pressed != 0U && elapsed >= G17_DEBOUNCE_MS) {
                is_pressed = 1U;
                eng->matrix_change_ms[i] = now_ms;
            }
        } else {
            if (raw_pressed != 0U) {
                eng->matrix_change_ms[i] = now_ms;
            } else if (elapsed >= G17_DEBOUNCE_MS) {
                is_pressed = 0U;
                eng->matrix_change_ms[i] = now_ms;
            }
        }
        if (is_pressed != 0U) {
            next_stable |= bit;
        }
        raw >>= 1;
        stable >>= 1;
        bit <<= 1;
    }
    eng->matrix_stable = next_stable;
}

void g17_engine_feed_touch(G17_XDATA G17Engine *eng, const uint16_t raw_counts[G17_TOUCH_CHANNELS],
                           uint8_t led_busy, uint32_t now_ms) {
    uint8_t i;
    uint16_t deltas[G17_TOUCH_CHANNELS];
    uint16_t weighted_idx_sum = 0U;
    uint16_t weight_sum = 0U;
    uint16_t raw_sum_delta = 0U;
    uint16_t max_delta = 0U;
    uint16_t raw_max_delta = 0U;
    uint8_t max_zone = 0U;
    uint16_t pos;
    uint8_t firm_contact;
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
            (uint16_t)(((uint32_t)eng->touch_filt[i] + (uint32_t)raw_counts[i] + 1U) >> 1);
        uint16_t base = eng->touch_baseline[i];
        uint16_t raw_d = (base > raw_counts[i]) ? (uint16_t)(base - raw_counts[i]) : 0U;
        uint16_t d;
        eng->touch_filt[i] = filt;
        if (raw_d > raw_max_delta) {
            raw_max_delta = raw_d;
        }
        if (raw_d > G17_TOUCH_NOISE_FLOOR) {
            raw_sum_delta = (uint16_t)(raw_sum_delta + raw_d);
        }
        d = (base > filt) ? (uint16_t)(base - filt) : 0U;
        deltas[i] = d;
        if (d > max_delta) {
            max_delta = d;
            max_zone = i;
        }
        if (d > G17_TOUCH_NOISE_FLOOR) {
            uint16_t w = (uint16_t)(((d - G17_TOUCH_NOISE_FLOOR) >> 6) + 1U);
            weighted_idx_sum = (uint16_t)(weighted_idx_sum + w * (uint16_t)(i * 100U));
            weight_sum = (uint16_t)(weight_sum + w);
        }
    }

    firm_contact = (raw_max_delta >= eng->touch_press_thresh ||
                    raw_sum_delta >= (uint16_t)(eng->touch_press_thresh + 40U))
                       ? 1U
                       : 0U;

    if (eng->touch_active != 0U) {
        pressed_now = (raw_sum_delta >= eng->touch_release_thresh) ? 1U : 0U;
    } else if (firm_contact != 0U) {
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
        if (weight_sum > 0U && (firm_contact != 0U || eng->touch_active == 0U)) {
            uint16_t p300 = (uint16_t)((weighted_idx_sum + (weight_sum >> 1)) / weight_sum);
            pos = (uint16_t)(p300 * 3U + (p300 + 1U) / 3U);
            if (pos > G17_SLIDER_POS_MAX) {
                pos = G17_SLIDER_POS_MAX;
            }
            eng->slider_pos = pos;
        } else {
            pos = eng->slider_pos;
        }

        if (eng->touch_active == 0U) {
            eng->touch_active = 1U;
            eng->touch_state = G17_TOUCH_ARMED;
            eng->touch_swipe_dir = 0U;
            eng->touch_start_zone = max_zone;
            eng->touch_start_pos = pos;
            eng->touch_anchor_pos = pos;
            eng->touch_extreme_pos = pos;
            eng->touch_arm_ms = now_ms;
        } else if (eng->touch_state == G17_TOUCH_ARMED ||
                   eng->touch_state == G17_TOUCH_HOLDING) {
            if (abs_diff_u16(pos, eng->touch_start_pos) >= G17_TOUCH_SLIDE_ENTER_DELTA) {
                uint8_t up = (pos < eng->touch_start_pos) ? 1U : 0U;
                eng->touch_state = G17_TOUCH_SWIPING;
                eng->touch_swipe_dir = up ? 1U : 2U;
                eng->touch_anchor_pos = pos;
                eng->touch_extreme_pos = pos;
                emit_swipe_step(eng, up, now_ms);
            } else if (eng->touch_state == G17_TOUCH_ARMED &&
                       (uint32_t)(now_ms - eng->touch_arm_ms) >= G17_TOUCH_HOLD_COMMIT_MS) {
                eng->touch_state = G17_TOUCH_HOLDING;
            }
        } else if (eng->touch_state == G17_TOUCH_SWIPING) {
            step_touch_swiping(eng, pos, now_ms);
        }
    } else {
        if (eng->touch_active != 0U) {
            if ((uint32_t)(now_ms - eng->touch_release_guard_ms) >= G17_TOUCH_RELEASE_GUARD_MS) {
                if (eng->touch_state == G17_TOUCH_ARMED) {
                    queue_pulse(eng, eng->touch_start_zone, now_ms);
                }
                eng->touch_active = 0U;
                eng->touch_swipe_dir = 0U;
                eng->touch_arm_hits = 0U;
                eng->touch_state = G17_TOUCH_IDLE;
            }
        } else {
            /* Idle: recover fast if finger was held during power-on cal, else track drift slowly. */
            for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
                if (eng->touch_filt[i] > eng->touch_baseline[i] + 32U) {
                    eng->touch_baseline[i] +=
                        (uint16_t)((eng->touch_filt[i] - eng->touch_baseline[i]) >> 2);
                }
            }
            eng->touch_drift_div++;
            if (eng->touch_drift_div >= 8U) {
                eng->touch_drift_div = 0U;
                for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
                    if (eng->touch_filt[i] > eng->touch_baseline[i]) {
                        eng->touch_baseline[i]++;
                    } else if (eng->touch_filt[i] < eng->touch_baseline[i] &&
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

void g17_engine_tick(G17_XDATA G17Engine *eng, uint32_t now_ms) {
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

    /* 2. Continuous contact bit + zone hold when in G17_TOUCH_HOLDING */
    if (eng->touch_active != 0U) {
        next_bitmap |= ((uint32_t)1UL << G17_BIT_TOUCH_CONTACT);
        if (eng->touch_state == G17_TOUCH_HOLDING &&
            eng->touch_start_zone < G17_TOUCH_CHANNELS) {
            next_bitmap |= ((uint32_t)1UL << (G17_BIT_TOUCH_BASE + eng->touch_start_zone));
        }
    }

    /* 3. Advance discrete pulse timers (T1..T4 short tap + fast SWIPE_UP / SWIPE_DOWN) */
    for (i = 0U; i < 6U; ++i) {
        uint8_t mask = (uint8_t)(1U << i);
        uint32_t on_ms = (i >= 4U) ? G17_SWIPE_PULSE_ON_MS : G17_PULSE_ON_MS;
        uint32_t gap_ms = (i >= 4U) ? G17_SWIPE_PULSE_GAP_MS : G17_PULSE_GAP_MS;
        if ((eng->pulse_active & mask) != 0U) {
            if ((uint32_t)(now_ms - eng->pulse_timer_ms[i]) >= on_ms) {
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
            if ((uint32_t)(now_ms - eng->pulse_timer_ms[i]) >= gap_ms) {
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
        eng->flags != eng->last_sent_flags ||
        (eng->touch_active != 0U &&
         abs_diff_u16(eng->slider_pos, eng->last_sent_slider_pos) >= G17_SLIDER_REPORT_DELTA)) {
        eng->report_pending = 1U;
    }
}

void g17_engine_set_usb_suspended(G17_XDATA G17Engine *eng, uint8_t suspended) {
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

uint8_t g17_engine_has_pending_input(const G17_XDATA G17Engine *eng) {
    return eng->report_pending;
}

void g17_engine_build_input_report(G17_XDATA G17Engine *eng, uint8_t out_buf[8]) {
    uint32_t bm = eng->logical_bitmap;
    uint16_t pos = eng->slider_pos;
    eng->seq++;
    out_buf[0] = G17_INPUT_REPORT_ID;
    out_buf[1] = (uint8_t)(bm & 0xFFU);
    out_buf[2] = (uint8_t)((bm >> 8) & 0xFFU);
    out_buf[3] = (uint8_t)((bm >> 16) & 0xFFU);
    out_buf[4] = (uint8_t)((bm >> 24) & 0xFFU);
    out_buf[5] = eng->flags;
    out_buf[6] = (uint8_t)(pos & 0xFFU);
    out_buf[7] = (uint8_t)((pos >> 8) & 0xFFU);

    eng->last_sent_bitmap = bm;
    eng->last_sent_flags = eng->flags;
    eng->last_sent_slider_pos = pos;
    eng->report_pending = 0U;
}

void g17_engine_build_caps_feature(const G17_XDATA G17Engine *eng, uint8_t out_buf[16]) {
    memset(out_buf, 0, 16U);
    out_buf[0] = G17_FEATURE_CAPS_ID;
    out_buf[1] = 2U;                        /* protocol v2: includes 0..1000 slider_pos */
    out_buf[2] = G17_MECH_KEY_COUNT + 6U;   /* 17 mech + 4 touch zones + 2 swipe */
    out_buf[3] = 0x03U;                     /* caps: bit0 = linear slider, bit1 = RGB LED */
    out_buf[4] = (uint8_t)(eng->touch_press_thresh & 0xFFU);
    out_buf[5] = (uint8_t)(eng->touch_swipe_step & 0xFFU);
    out_buf[6] = eng->led.brightness;
    out_buf[7] = eng->flags;
}

void g17_engine_build_state_feature(const G17_XDATA G17Engine *eng, uint8_t out_buf[8]) {
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

void g17_engine_build_diag_feature(const G17_XDATA G17Engine *eng, uint8_t out_buf[32]) {
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

void g17_engine_handle_output_report(G17_XDATA G17Engine *eng, const uint8_t *buf, uint8_t len) {
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
        if (buf[2] >= 12U && buf[2] <= 250U) {
            eng->touch_press_thresh = buf[2];
        }
        if (buf[3] >= 6U && buf[3] < eng->touch_press_thresh) {
            eng->touch_release_thresh = buf[3];
        }
        if (buf[4] >= 20U && buf[4] <= 250U) {
            eng->touch_swipe_step = buf[4];
        }
    }
}
