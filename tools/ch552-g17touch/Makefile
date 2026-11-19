SDCC ?= sdcc
PACKIHX ?= packihx
GCC ?= gcc

BUILD_DIR := .build
SRC_CORE := lib/g17_core/g17_engine.c
SRC_MCU := src/main.c src/usb_hid.c src/hw_scan.c
REL := $(BUILD_DIR)/g17_engine.rel $(BUILD_DIR)/main.rel $(BUILD_DIR)/usb_hid.rel $(BUILD_DIR)/hw_scan.rel

CFLAGS_SDCC := -mmcs51 --model-large --std-c99 --opt-code-size -DFREQ_SYS=24000000 -Ilib/g17_core -Isrc
LFLAGS_SDCC := -mmcs51 --model-large --iram-size 0x0100 --xram-size 0x0300 --xram-loc 0x0100 --code-size 0x3800

.PHONY: all test clean

all: $(BUILD_DIR)/g17touch.hex

$(BUILD_DIR):
	mkdir $(BUILD_DIR)

$(BUILD_DIR)/g17_engine.rel: $(SRC_CORE) lib/g17_core/g17_engine.h | $(BUILD_DIR)
	$(SDCC) -c $(CFLAGS_SDCC) $< -o $@

$(BUILD_DIR)/%.rel: src/%.c src/ch552.h lib/g17_core/g17_engine.h | $(BUILD_DIR)
	$(SDCC) -c $(CFLAGS_SDCC) $< -o $@

$(BUILD_DIR)/g17touch.ihx: $(REL)
	$(SDCC) $(LFLAGS_SDCC) $^ -o $@

$(BUILD_DIR)/g17touch.hex: $(BUILD_DIR)/g17touch.ihx
	$(PACKIHX) $< > $@

test:
	$(GCC) -std=c99 -Wall -Wextra -Werror -Ilib/g17_core $(SRC_CORE) test/test_g17_engine.c -o $(BUILD_DIR)/test_g17_engine.exe
	./$(BUILD_DIR)/test_g17_engine.exe

clean:
	rm -rf $(BUILD_DIR)
