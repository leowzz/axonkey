# Kivo K18 Lite (RP2040) 固件

面向 `YD-RP2040` 18 键小屏版小键盘的 Vendor Raw HID 固件。通过单一厂商页 HID 接口（`0x2E8A:0xA018`，`Usage Page 0xFF60 / Usage 0x01`）向 Axonkey 上报 18 键全键无冲位图，并接收 1bpp `128×32` OLED 帧缓冲与控制租约，macOS 与 Windows 双端均无需安装拦截驱动。

## 硬件定义

- 主控：`vccgnd_yd_rp2040`（Earle Philhower Arduino-Pico + TinyUSB）
- 按键：`K01..K18` 直连 `GPIO 1..18`（`INPUT_PULLUP`，低电平触发，10ms 独立每键消抖：按下零延迟触发、按住防抖动续期、松开延迟确认）
- 屏幕：`SSD1306 128×32` I2C OLED（`SDA = GPIO 28`，`SCL = GPIO 29`，`400 kHz`，7-bit 地址 `0x3C`）
- 串口与升级：保留默认 `115200` USB CDC（支持 1200bps 自动进入下载模式）与 RP2040 Flash 唯一硬件序列号（支持多台同型号设备同时接入）
- 看门狗：`8000 ms` 主循环喂狗；3 分钟无按键且无主机活动自动息屏防烧屏，按键或主机指令自动唤醒

## HID 报文约定

单一 Top-Level Application Collection（`Usage Page 0xFF60`，`Usage 0x01`）：

| Report ID | 类型 | 线长 | 结构（紧跟 1B Report ID 的载荷） |
| --- | --- | --- | --- |
| `0x01` | Input | 8 B | `key_bitmap: u32 LE`（`bit 0..17` 对应 `K01..K18`）、`enc_delta: i8 (0)`、`flags: u8`（`bit0=oled_online, bit1=oled_sleeping, bit2=host_lease_active`）、`seq: u8` |
| `0x02` | Output | 64 B | `op=0x01` `CONTROL_LEASE`：`[0x01, mode, lease_sec, brightness, power_save, ...]`；`op=0x02` `FRAME_CHUNK`：`[0x02, frame_id, flags, offset_lo, offset_hi, len, data[56], 0]`（`flags`: `0x01=CLEAR_STAGING`, `0x02=COMMIT`，`128×32` 1bpp 行优先 MSB 在前共 `512 B`） |
| `0x10` | Feature | 16 B | `[ver=1, keys=18, caps=0x01, width=128 LE, height=32 LE, fmt=1, brightness, status_flags, 0×5]` |
| `0x11` | Feature | 8 B | 当前状态快照 `[key_bitmap: u32 LE, 0, status_flags, seq]` |

## 单测与构建

```sh
cd tools/rp2040-k18
pio test -e native
pio run -e rp2040
```

生成的固件位于 `.pio/build/rp2040/firmware.uf2`。刷写实机时可执行 `pio run -e rp2040 -t upload`（通过 1200bps 串口自动触发 `picotool`），或按住 `BOOT` 上电后将 `firmware.uf2` 拷入 `RPI-RP2` 盘符。
