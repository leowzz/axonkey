#include "hw_scan.h"
#include "ch552.h"

#define LED_COUNT 17U

/*
 * CH552 TouchKey channels wired on H1 in physical top-to-bottom order (T1..T4):
 *   T1 (top)    = H1 pin 1 = TIN2 (P1.4) -> channel 3
 *   T2 (upper)  = H1 pin 2 = TIN4 (P1.6) -> channel 5
 *   T3 (lower)  = H1 pin 3 = TIN5 (P1.7) -> channel 6
 *   T4 (bottom) = H1 pin 5 = TIN1 (P1.1) -> channel 2
 */
static const __code uint8_t s_touch_ch[G17_TOUCH_CHANNELS] = {3U, 5U, 6U, 2U};
static const __code uint8_t s_touch_pu_mask[G17_TOUCH_CHANNELS] = {0x10U, 0x40U, 0x80U, 0x02U};
static uint8_t s_touch_idx = 0U;
static uint8_t s_touch_started = 0U;
static uint8_t s_touch_chg_skips = 0U;
static uint8_t s_diag_idle_p3 = 0x1FU;
static uint8_t s_diag_drv_p3[5] = {0x1FU, 0x1FU, 0x1FU, 0x1FU, 0x1FU};
static uint16_t s_touch_buf[G17_TOUCH_CHANNELS];

static void delay_short(void) {
    uint8_t i = 24U;
    while (i--) {
        __asm__("nop");
    }
}

void hw_init_gpio_and_clock(void) {
    uint16_t settle;
    /* Configure 24 MHz internal oscillator and enable watchdog (~1.5s at 24MHz). */
    SAFE_MOD = 0x55U;
    SAFE_MOD = 0xAAU;
    CLOCK_CFG = 0x86U; /* 24 MHz internal clock */
    WAKE_CTRL = 0x00U; /* Power-Down sleep is never entered */
    GLOBAL_CFG |= 0x01U; /* Enable WDOG reset */
    SAFE_MOD = 0x00U;

    for (settle = 0U; settle < 1200U; ++settle) {
        __asm__("nop");
    }

    /* Matrix K1..K5 (P3.0..P3.4): open-drain with pull-ups (external 1k R6..R10). */
    P3_MOD_OC |= 0x1FU;
    P3_DIR_PU |= 0x1FU;
    P3 |= 0x1FU;

    /* P1.5 (MOSI / LED_BUS) push-pull output low; Touch pins P1.1,P1.4,P1.6,P1.7 float on scan. */
    P1_MOD_OC &= (uint8_t)~0x20U;
    P1_DIR_PU |= 0x20U;
    P1_5 = 0;

    P1 |= 0xD2U;
    P1_MOD_OC &= (uint8_t)~0xD2U;
    P1_DIR_PU |= 0xD2U;
}

/* Drive line `drv` low while reading the other 4 lines in K1..K5 order. */
static uint8_t read_k_line(uint8_t idx) {
    switch (idx) {
        case 0U: return P3_0 ? 1U : 0U; /* K1 */
        case 1U: return P3_1 ? 1U : 0U; /* K2 */
        case 2U: return P3_2 ? 1U : 0U; /* K3 */
        case 3U: return P3_4 ? 1U : 0U; /* K4 */
        default: return P3_3 ? 1U : 0U; /* K5 */
    }
}

static void write_k_line(uint8_t idx, uint8_t val) {
    switch (idx) {
        case 0U: P3_0 = val; break;
        case 1U: P3_1 = val; break;
        case 2U: P3_2 = val; break;
        case 3U: P3_4 = val; break;
        default: P3_3 = val; break;
    }
}

uint32_t hw_scan_matrix_20(void) {
    uint32_t mask = 0UL;
    uint8_t slot = 0U;
    uint8_t idle_mask = 0U;
    uint8_t drv;
    uint8_t sns;

    P3 |= 0x1FU;
    delay_short();
    s_diag_idle_p3 = (uint8_t)((P3 & 0x1FU) | ((CLOCK_CFG & bRST) ? 0x20U : 0U));
    for (sns = 0U; sns < 5U; ++sns) {
        if (sns == 3U) {
            continue; /* Slot 23 is reserved for S21 (key 5 on RST -> VCC). */
        }
        if (read_k_line(sns) == 0U) {
            idle_mask |= (uint8_t)(1U << sns);
            mask |= (1UL << (20U + sns));
        }
    }
    if ((CLOCK_CFG & bRST) != 0U) {
        mask |= (1UL << 23U);
    }

    for (drv = 0U; drv < 5U; ++drv) {
        write_k_line(drv, 0U);
        delay_short();
        s_diag_drv_p3[drv] = (uint8_t)(P3 & 0x1FU);
        for (sns = 0U; sns < 5U; ++sns) {
            if (sns == drv) {
                continue;
            }
            if (read_k_line(sns) == 0U && (idle_mask & (uint8_t)(1U << sns)) == 0U) {
                mask |= (1UL << slot);
            }
            slot++;
        }
        write_k_line(drv, 1U);
    }
    return mask;
}

void hw_get_matrix_diag(uint8_t *out_idle_p3, uint8_t out_drv_p3[5]) {
    uint8_t i;
    *out_idle_p3 = s_diag_idle_p3;
    for (i = 0U; i < 5U; ++i) {
        out_drv_p3[i] = s_diag_drv_p3[i];
    }
}

uint8_t hw_poll_touch_4ch(uint16_t out_counts[G17_TOUCH_CHANNELS]) {
    uint8_t i;
    uint8_t lo;
    uint8_t hi;
    if (s_touch_started == 0U) {
        P1_DIR_PU |= 0xD2U;
        P1_DIR_PU &= (uint8_t)~s_touch_pu_mask[0];
        TKEY_CTRL = (uint8_t)(bTKC_2MS | s_touch_ch[0]);
        s_touch_idx = 0U;
        s_touch_started = 1U;
        return 0U;
    }

    if ((TKEY_CTRL & bTKC_IF) == 0U) {
        return 0U;
    }

    lo = TKEY_DATL;
    hi = TKEY_DATH;
    if ((hi & 0x80U) != 0U) {
        s_touch_chg_skips++;
        TKEY_CTRL = (uint8_t)(bTKC_2MS | s_touch_ch[s_touch_idx]);
        return 0U;
    }
    {
        uint16_t sample = (uint16_t)lo | ((uint16_t)(hi & 0x3FU) << 8);
        /* Reject sporadic 0/1 hardware glitch reads (valid baseline is ~6000..6800). */
        if (sample < 1500U) {
            s_touch_chg_skips++;
            TKEY_CTRL = (uint8_t)(bTKC_2MS | s_touch_ch[s_touch_idx]);
            return 0U;
        }
        s_touch_buf[s_touch_idx] = sample;
    }
    P1_DIR_PU |= 0xD2U;

    s_touch_idx++;
    if (s_touch_idx >= G17_TOUCH_CHANNELS) {
        s_touch_idx = 0U;
        for (i = 0U; i < G17_TOUCH_CHANNELS; ++i) {
            out_counts[i] = s_touch_buf[i];
        }
        P1_DIR_PU &= (uint8_t)~s_touch_pu_mask[0];
        TKEY_CTRL = (uint8_t)(bTKC_2MS | s_touch_ch[0]);
        return 1U;
    }

    P1_DIR_PU &= (uint8_t)~s_touch_pu_mask[s_touch_idx];
    TKEY_CTRL = (uint8_t)(bTKC_2MS | s_touch_ch[s_touch_idx]);
    return 0U;
}

uint8_t hw_get_touch_chg_skips(void) {
    return s_touch_chg_skips;
}

static void ws2812_send_byte(uint8_t val) {
    uint8_t bit;
    for (bit = 0U; bit < 8U; ++bit) {
        if ((val & 0x80U) != 0U) {
            P1_5 = 1;
            __asm__("nop"); __asm__("nop"); __asm__("nop"); __asm__("nop");
            __asm__("nop"); __asm__("nop"); __asm__("nop"); __asm__("nop");
            __asm__("nop"); __asm__("nop"); __asm__("nop"); __asm__("nop");
            P1_5 = 0;
            __asm__("nop"); __asm__("nop");
        } else {
            P1_5 = 1;
            __asm__("nop"); __asm__("nop"); __asm__("nop"); __asm__("nop");
            P1_5 = 0;
            __asm__("nop"); __asm__("nop"); __asm__("nop"); __asm__("nop");
            __asm__("nop"); __asm__("nop"); __asm__("nop"); __asm__("nop");
        }
        val <<= 1;
    }
}

void hw_ws2812_show_solid(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness) {
    uint8_t i;
    uint8_t sr = (uint8_t)(((uint16_t)r * brightness) / 100U);
    uint8_t sg = (uint8_t)(((uint16_t)g * brightness) / 100U);
    uint8_t sb = (uint8_t)(((uint16_t)b * brightness) / 100U);

    EA = 0;
    for (i = 0U; i < LED_COUNT; ++i) {
        ws2812_send_byte(sg);
        ws2812_send_byte(sr);
        ws2812_send_byte(sb);
    }
    P1_5 = 0;
    EA = 1;
}
