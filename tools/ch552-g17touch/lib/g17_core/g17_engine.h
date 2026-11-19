#ifndef G17_ENGINE_H
#define G17_ENGINE_H

#include <stdint.h>

#ifdef __SDCC
#define G17_XDATA __xdata
#else
#define G17_XDATA
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Logical input bit assignments in the 32-bit key_bitmap */
#define G17_MECH_KEY_COUNT 17U
#define G17_MATRIX_SLOTS 25U
#define G17_TOUCH_CHANNELS 4U

#define G17_BIT_TOUCH_BASE 20U     /* bits 20..23: T1..T4 (top to bottom) */
#define G17_BIT_SWIPE_UP 24U       /* bit 24: slider swipe up pulse */
#define G17_BIT_SWIPE_DOWN 25U     /* bit 25: slider swipe down pulse */
#define G17_BIT_TOUCH_CONTACT 26U  /* bit 26: 1 while finger contacts slider, 0 on lift */

#define G17_SLIDER_POS_MAX 1000U
#define G17_SLIDER_REPORT_DELTA 5U /* 0.5% fine linear movement reporting step */

#define G17_INPUT_REPORT_ID 0x01U
#define G17_OUTPUT_REPORT_ID 0x02U
#define G17_FEATURE_CAPS_ID 0x10U
#define G17_FEATURE_STATE_ID 0x11U
#define G17_FEATURE_DIAG_ID 0x12U

#define G17_FLAG_TOUCH_ACTIVE 0x01U
#define G17_FLAG_USB_SUSPENDED 0x02U
#define G17_FLAG_LED_HOST_CTRL 0x04U

#define G17_DEBOUNCE_MS 10U
#define G17_TOUCH_CAL_SAMPLES 16U
#define G17_TOUCH_NOISE_FLOOR 16U
#define G17_TOUCH_DEFAULT_PRESS_THRESH 140U
#define G17_TOUCH_DEFAULT_RELEASE_THRESH 42U
#define G17_TOUCH_RELEASE_GUARD_MS 24U
#define G17_TOUCH_SLIDE_ENTER_DELTA 110U
#define G17_TOUCH_DEFAULT_SWIPE_STEP 125U
#define G17_TOUCH_HOLD_COMMIT_MS 200U
#define G17_TOUCH_ARM_CONFIRM_FRAMES 2U
#define G17_PULSE_ON_MS 28U
#define G17_PULSE_GAP_MS 14U
#define G17_SWIPE_PULSE_ON_MS 12U
#define G17_SWIPE_PULSE_GAP_MS 8U

typedef enum {
    G17_TOUCH_IDLE = 0,
    G17_TOUCH_ARMED = 1,
    G17_TOUCH_HOLDING = 2,
    G17_TOUCH_SWIPING = 3
} G17TouchState;

typedef struct {
    uint8_t mode;       /* 0=off, 1=solid, 2=breath/activity */
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint8_t brightness; /* 0..100 */
    uint8_t dirty;
} G17LedConfig;

typedef struct {
    /* 20 matrix slots -> per-slot 10ms debounce */
    uint32_t matrix_stable;
    uint32_t matrix_last_raw;
    uint32_t matrix_change_ms[G17_MATRIX_SLOTS];

    /* 4 capacitive touch channels (TIN1, TIN2, TIN4, TIN5) */
    uint16_t touch_baseline[G17_TOUCH_CHANNELS];
    uint16_t touch_filt[G17_TOUCH_CHANNELS];
    uint32_t touch_cal_acc[G17_TOUCH_CHANNELS];
    uint8_t touch_cal_count;
    uint8_t touch_calibrated;
    uint16_t touch_press_thresh;
    uint16_t touch_release_thresh;
    uint16_t touch_swipe_step;
    uint8_t touch_drift_div;
    uint8_t touch_arm_hits;

    /* Touch slider state machine */
    G17TouchState touch_state;
    uint8_t touch_active;
    uint8_t touch_swipe_dir; /* 0=none, 1=up, 2=down */
    uint8_t touch_start_zone;
    uint16_t touch_start_pos;
    uint16_t touch_anchor_pos;
    uint16_t touch_extreme_pos;
    uint16_t slider_pos;     /* 0..1000 continuous top-to-bottom linear position */
    uint16_t last_sent_slider_pos;
    uint32_t touch_arm_ms;
    uint32_t touch_release_guard_ms;

    /* Queued discrete pulses for T1..T4 taps and SWIPE_UP / SWIPE_DOWN */
    uint8_t pulse_remaining[6]; /* 0..3: T1..T4, 4: SWIPE_UP, 5: SWIPE_DOWN */
    uint8_t pulse_active;       /* bitmask matching pulse_remaining indices */
    uint8_t pulse_in_gap;
    uint32_t pulse_timer_ms[6];

    /* Combined logical output bitmap & HID state */
    uint32_t logical_bitmap;
    uint32_t last_sent_bitmap;
    uint8_t flags;
    uint8_t last_sent_flags;
    uint8_t seq;
    uint8_t report_pending;

    /* Raw hardware diagnostics for Feature 0x12 */
    uint8_t diag_idle_p3;
    uint8_t diag_drv_p3[5];
    uint8_t diag_touch_chg_skips;
    uint16_t diag_touch_raw[G17_TOUCH_CHANNELS];

    G17LedConfig led;
} G17Engine;

void g17_engine_init(G17_XDATA G17Engine *eng);
void g17_engine_set_matrix_map(const uint8_t map[G17_MATRIX_SLOTS]);

/* Feed raw active-high matrix mask (slots 0..24). */
void g17_engine_poll_matrix(G17_XDATA G17Engine *eng, uint32_t raw_matrix_mask, uint32_t now_ms);

/* Feed 4 raw TouchKey readings in physical top-to-bottom order (T1..T4).
 * When led_busy != 0 (WS2812 frame active or cooling down), sample is ignored. */
void g17_engine_feed_touch(G17_XDATA G17Engine *eng,
                           const uint16_t raw_counts[G17_TOUCH_CHANNELS], uint8_t led_busy,
                           uint32_t now_ms);

/* Advance pulse timers and compute current logical_bitmap. */
void g17_engine_tick(G17_XDATA G17Engine *eng, uint32_t now_ms);

/* USB suspend notification: never sleeps MCU, only marks flag & dims LEDs. */
void g17_engine_set_usb_suspended(G17_XDATA G17Engine *eng, uint8_t suspended);

/* HID report helpers. */
uint8_t g17_engine_has_pending_input(const G17_XDATA G17Engine *eng);
void g17_engine_build_input_report(G17_XDATA G17Engine *eng, uint8_t out_buf[8]);
void g17_engine_build_caps_feature(const G17_XDATA G17Engine *eng, uint8_t out_buf[16]);
void g17_engine_build_state_feature(const G17_XDATA G17Engine *eng, uint8_t out_buf[8]);
void g17_engine_build_diag_feature(const G17_XDATA G17Engine *eng, uint8_t out_buf[32]);
void g17_engine_handle_output_report(G17_XDATA G17Engine *eng, const uint8_t *buf, uint8_t len);

#ifdef __cplusplus
}
#endif

#endif
