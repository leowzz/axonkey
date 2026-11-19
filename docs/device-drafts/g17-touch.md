# G17 Touch (`最丐17+4TPRO机械键盘`) 图稿与设备描述交接

状态：正式描述符已内置（[`public/device-descriptors/g17-touch.svg`](../../public/device-descriptors/g17-touch.svg)），配套 CH552G Raw HID 固件源码位于 [`tools/ch552-g17touch/`](../../tools/ch552-g17touch/README.md)。

## 身份匹配

| 条件 | 值 |
| --- | --- |
| 传输协议 (`transport`) | `usb-hid` |
| 厂商 / 产品标识 (`vid` / `pid`) | `0x1209` / `0xA017` |
| HID 顶层集合 (`usage-page` / `usage`) | `0xFF60` / `0x01` |
| 多实例序列号策略 (`serial-policy`) | `reject-ambiguous`（固件读取 CH552 UID 暴露 `G17-XXXXXXXX` 唯一序列号） |

## 输入清单（共 23 个输入）

Input Report `0x01` 定长 8 字节（`[0x01, b0, b1, b2, b3, flags, pos_lo, pos_hi]`），`encoding="bit-field"`，`payload-offset="0"`，`original="false"`：

- **左侧 17 颗机械按键**（`g17.touch.num`、`div`、`mul`、`sub`、`k7`–`k9`、`add`、`k4`–`k6`、`k1`–`k3`、`enter`、`k0`、`dot`）：占 `offset=1` `bit 0..7`、`offset=2` `bit 0..7`、`offset=3` `bit 0`。
- **右侧 4 段人字形电容滑条**（`H1` 从上到下依次为 `TIN2(ch3)` / `TIN4(ch5)` / `TIN5(ch6)` / `TIN1(ch2)`）：
  - `g17.touch.t1`～`t4`：占 `offset=3` `bit 4..7`（短触点按或长按保持）。
  - `g17.touch.swipeUp` / `g17.touch.swipeDown`：占 `offset=4` `bit 0..1`（滑条连续上下滑动步进脉冲）。
  - **线性连续位置与接触态预留（供后续线性选择 / HUD 扩展）**：
    - `offset=4` `bit 2`（`TOUCH_CONTACT`）与 `flags` `bit 0`：手指接触滑条期间保持 `1`，松手释放归 `0`。
    - `offset=6..7`（`slider_pos: u16 LE`，范围 `0..1000`，顶部 `0`、底部 `1000`）：每变化 `>= 5`（`0.5%`）实时上报，并在抬手脱离瞬间自动冻结抬手前坐标，避免松手确认时跳变；可直接通过 `axonkey.device/1` 的 `AxisU16`（`offset="6" min="0" max="1000"`）映射为 `0.0..1.0` 连续值。

## 硬件矩阵与多键冲突边界

原厂硬件并非全键无冲（NKRO）设计，配置多键或组合键时需注意以下物理限制（电路压降推算与完整冲突表见 [`tools/ch552-g17touch/README.md`](../../tools/ch552-g17touch/README.md#硬件电路与多键冲突边界)）：

- **查理复用串键**：`CH552G` 由 `HT7533` 以 `3.3V` 供电，矩阵键共用 `K1 / K2 / K3 / K5` 查理复用 + `LL4148` 二极管 + `1kΩ` 上拉。当同时按下首尾相接的两颗键（如 `Num (K1←K2)` + `7 (K2←K3)`）时，两颗二极管同向串联后的残余电平（约 `1.28V`）落在 `3.3V` 输入翻转阈值附近，可能串出第 3 颗鬼键（如 `/`）或产生抖动。
- **`8 / 4 / 6 / 2` 对地直连吞键与变键**：量产实机 PCB 将 `8`、`4`、`6`、`2` 直接接在 `K1 / K2 / K3 / K5 → GND` 上。按住其中任意一颗会把对应总线钳死在 `0V`，导致该线负责采样的 3 颗键被物理掩蔽失灵（如按住 `8` 时 `-`、`+`、`Enter` 无响应），而按该线负责驱动的 3 颗键则会等价变成另一颗对地键（如 `8 + Num` 等价于 `8 + 4`）。
- **无冲组合建议**：数字 **`5`（`S21`，独立接 `RST → VCC`）** 与右侧电容触摸条（`T1`–`T4`）均独立于 `K1`–`K5` 总线，可与其他单键无冲组合；避免用 `8 / 4 / 6 / 2` 作为长按修饰键。

## 待实机刷写与验收项

- [x] 使用 SDCC 编译 `tools/ch552-g17touch` 为 `.hex` 并通过 `WCHISPTool` 刷入 CH552G（注意保持「使能 RST Pin」未勾选，否则按数字 `5` 会触发芯片硬件复位）。
- [x] 在实机上逐键核对 17 键矩阵与 `RST`（数字 `5`）物理槽位顺序（已固化于 `g17_engine.c` 中 `s_matrix_map`）。
- [x] 实机验收 Windows 免驱直连、全部 17 键及滑条 `T1`–`T4` 点按 / 长按 / 连续上下滑消歧义。
- [ ] 实机验收 macOS 免驱直连与长时间挂机不休眠睡死。
