#ifndef HW_SCAN_H
#define HW_SCAN_H

#include "g17_engine.h"
#include <stdint.h>

void hw_init_gpio_and_clock(void);
uint32_t hw_scan_matrix_20(void);
uint8_t hw_poll_touch_4ch(uint16_t out_counts[G17_TOUCH_CHANNELS]);
void hw_ws2812_show_solid(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness);

#endif
