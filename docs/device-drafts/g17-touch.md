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

Input Report `0x01` 定长 8 字节（`[0x01, b0, b1, b2, b3, flags, seq, 0]`），`encoding="bit-field"`，`payload-offset="0"`，`original="false"`：

- **左侧 17 颗机械按键**（`g17.touch.num`、`div`、`mul`、`sub`、`k7`–`k9`、`add`、`k4`–`k6`、`k1`–`k3`、`enter`、`k0`、`dot`）：占 `offset=1` `bit 0..7`、`offset=2` `bit 0..7`、`offset=3` `bit 0`。
- **右侧 4 段人字形电容滑条**（`TIN1` / `TIN2` / `TIN4` / `TIN5`）：
  - `g17.touch.t1`～`t4`：占 `offset=3` `bit 4..7`（短触点按或长按保持）。
  - `g17.touch.swipeUp` / `g17.touch.swipeDown`：占 `offset=4` `bit 0..1`（滑条上下滑动步进脉冲）。

## 待实机刷写与验收项

- [ ] 使用 SDCC 编译 `tools/ch552-g17touch` 为 `.hex` 并通过 `WCHISPTool` 刷入 CH552G（注意保持「使能 RST Pin」未勾选）。
- [ ] 在实机上逐键核对 5×4 矩阵物理槽位顺序（如实机矩阵焊盘排列与默认顺序不同，调整 `g17_engine.c` 中 `s_matrix_map`）。
- [ ] 实机验收 Windows / macOS 免驱直连、滑条上滑/下滑与 4 段点按消歧义、Windows 长时间挂机不休眠睡死。
