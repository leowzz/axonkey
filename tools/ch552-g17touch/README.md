# G17 Touch (`最丐17+4TPRO机械键盘`) CH552G Raw HID 固件

面向基于 `CH552G` + `SL2.1A` USB Hub 的 17 键机械 + 4 段式电容触摸滑条小键盘的 Axonkey 免驱 Vendor Raw HID 固件（`0x1209:0xA017`，`Usage Page 0xFF60 / Usage 0x01`）。

## 相对原厂 `Ver202` 固件的关键改进

1. **彻底解决 USB 挂起睡死问题**：
   - 不调用 `PCON |= 0x02`（Power-Down 深度休眠），收到 `UIF_SUSPEND` 时仅熄灭 RGB 背光并置位状态标记，按键与触控扫描保持全天候响应，Windows USB 选择性暂停不会卡死设备。
2. **全键无冲位图上报**：
   - 5×4 矩阵（`K1..K5` = `P3.0, P3.1, P3.2, P3.4, P3.3`）独立 10ms 消抖上报，支持任意多键同时按住与修饰键组合。
3. **4 段电容滑条消歧义引擎（`TIN1/2/4/5`）**：
   - 硬件通道：`TIN1(P1.1)`、`TIN2(P1.4)`、`TIN4(P1.6)`、`TIN5(P1.7)`。
   - **上滑 / 下滑（`SWIPE_UP` / `SWIPE_DOWN`）**：手指沿滑条移动超过步进阈值时输出离散脉冲，支持连续滑动。
   - **4 段点按 / 按住（`T1..T4`）**：短触抬起发射点按脉冲，原地长按保持对应段位激活，滑动过程中不误触段位点按。
   - **WS2812 串扰隔离**：刷新 `P1.5/MOSI` 灯珠期间及之后 3ms 跳过 TouchKey 采样。

## HID 报文约定

| Report ID | 方向 | 线长 | 结构 |
| --- | --- | --- | --- |
| `0x01` | Input | 8 B | `[0x01, key_bitmap: u32 LE (bit0..16=K01..K17, bit20..23=T1..T4, bit24=SWIPE_UP, bit25=SWIPE_DOWN), flags, seq, 0]` |
| `0x02` | Output | 64 B | `op=0x01` 设置 RGB 背光 `[0x02, 0x01, mode, r, g, b, brightness]`；`op=0x02` 调节触摸灵敏度 `[0x02, 0x02, press_thresh, release_thresh, swipe_step]` |
| `0x10` | Feature | 16 B | 能力报告 `[0x10, ver=1, keys=23, caps=0x02, press_thresh, swipe_step, brightness, flags, ...]` |
| `0x11` | Feature | 8 B | 当前状态快照 |

## 构建与单测

```sh
cd tools/ch552-g17touch
make test   # 使用 gcc 运行主机端引擎单测
make        # 使用 SDCC 编译生成 .build/g17touch.hex
```

烧录到实机时打开 `WCHISPTool`（芯片选 `CH552`、`P3.6` 下载，**保持「使能 RST Pin 作为手工复位输入引脚」未勾选**），短接右上角 `S0` 方形/圆形焊盘上电后选择 `.build/g17touch.hex` 下载。
