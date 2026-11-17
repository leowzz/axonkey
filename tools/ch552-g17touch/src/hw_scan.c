#include "hw_scan.h"
#include "ch552.h"

#define LED_COUNT 17U

/*
 * CH552 TouchKey channels wired on H1 (top to bottom along slider):
 *   TIN1 = P1.1 -> channel 2
 *   TIN2 = P1.4 -> channel 3
 *   TIN4 = P1.6 -> channel 5
 *   TIN5 = P1.7 -> channel 6
 */
static const __code uint8_t s_touch_ch[G17_TOUCH_CHANNELS] = {2U, 3U, 5U, 6U};
static const __code uint8_t s_touch_pu_mask[G17_TOUCH_CHANNELS] = {0x02U, 0x10U, 0x40U, 0x80U};
static uint8_t s_touch_idx = 0U;
static uint8_t s_touch_started = 0U;
static uint16_t s_touch_buf[G17_TOUCH_CHANNELS];

static void delay_short(void) {
    uint8_t i = 24U;
    while (i--) {
        __asm__("nop");
    }
}

void hw_init_gpio_and_clock(void) {
    /* Configure 24 MHz internal oscillator and enable watchdog (~1.5s at 24MHz). */
    SAFE_MOD = 0x55U;
    SAFE_MOD = 0xAAU;
    CLOCK_CFG = 0x86U; /* 24 MHz internal clock */
    WAKE_CTRL = 0x00U; /* Power-Down sleep is never entered */
    GLOBAL_CFG |= 0x01U; /* Enable WDOG reset */
    SAFE_MOD = 0x00U;

    /* Matrix K1..K5 (P3.0..P3.4): open-drain with pull-ups (external 1k R6..R10). */
    P3_MOD_OC |= 0x1FU;
    P3_DIR_PU |= 0x1FU;
    P3 |= 0x1FU;

    /* P1.5 (MOSI / LED_BUS) push-pull output low; Touch pins P1.1,P1.4,P1.6,P1.7 float on scan. */
    P1_MOD_OC &= (uint8_t)~0x20U;
    P1_DIR_PU |= 0x20U;
    P1_5 = 0;

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
    uint8_t drv;
    uint8_t sns;

    P3 |= 0x1FU;
    for (drv = 0U; drv < 5U; ++drv) {
        write_k_line(drv, 0U);
        delay_short();
        for (sns = 0U; sns < 5U; ++sns) {
            if (sns == drv) {
                continue;
            }
            if (read_k_line(sns) == 0U) {
                mask |= (1UL << slot);
            }
            slot++;
        }
        write_k_line(drv, 1U);
    }
    return mask;
}

uint8_t hw_poll_touch_4ch(uint16_t out_counts[G17_TOUCH_CHANNELS]) {
    uint8_t i;
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

    s_touch_buf[s_touch_idx] = (uint16_t)TKEY_DATL | ((uint16_t)TKEY_DATH << 8);
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
