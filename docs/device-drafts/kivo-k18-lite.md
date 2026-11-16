# Kivo K18 Lite 图稿与设备描述交接

状态：正式描述符已内置（运行时资源为 [`public/device-descriptors/kivo-k18-lite.svg`](../../public/device-descriptors/kivo-k18-lite.svg)）。品牌 `Kivo`、型号 `K18 Lite`（基于 YD-RP2040 定制固件）及协议规范由仓库 `tools/rp2040-k18` 固件契约冻结；俯视几何依据实拍照片校正透视制作，不带键帽手写贴纸文案，统一按行从左至右编号为 `K01` 至 `K18`。

## 身份匹配

单一 Vendor Raw HID 顶层集合，macOS 与 Windows 双端均走用户态直连 `usb-hid`（免安装 Quarbor 拦截驱动）：

| 条件 | 值 |
| --- | --- |
| 传输协议 (`transport`) | `usb-hid` |
| 厂商 / 产品标识 (`vid` / `pid`) | `0x2E8A` / `0xA018` |
| HID 顶层集合 (`usage-page` / `usage`) | `0xFF60` / `0x01` |
| 多实例序列号策略 (`serial-policy`) | `reject-ambiguous`（固件暴露 RP2040 唯一硬件 Flash 序列号，支持多台同型号设备同时独立绑定） |

## 图稿布局与输入清单

设备 ID 为 `kivo.k18Lite`（前端 `DeviceKind` 为 `kivoK18Lite`），5 列 × 4 行布局（`viewBox="0 0 640 520"`）：

- **顶部中央偏上**：位于第 3 列（`K01`）正上方的 USB-C 接口示意，仅作装饰。
- **第 1 行左起 2 列（2u × 1u 凹槽）**：`SSD1306 128×32` I2C OLED 显示屏模块，仅作装饰，不声明输入与热区（屏幕内容由运行时 Output Report `0x02` 与固件本地状态页驱动）。
- **18 个机械按键输入**：Input Report `0x01` 定长 8 字节（`[0x01, b0, b1, b2, b3, enc, flags, seq]`），`encoding="bit-field"`，`payload-offset="0"`，`original="false"`，无历史 `legacy-key`：

| 行列位置 | 键帽标签 | 稳定输入 ID | Report `keys` 位域 (`offset` / `bit` / `width`) | 热区锚点 `(cx, cy)` |
| --- | --- | --- | --- | --- |
| 第 1 行 第 3～5 列 | `K01`～`K03` | `kivo.k18Lite.k01`～`k03` | `offset=1`，`bit=0..2`，`width=1` | `(320, 104)`、`(428, 104)`、`(536, 104)` |
| 第 2 行 第 1～5 列 | `K04`～`K08` | `kivo.k18Lite.k04`～`k08` | `offset=1`，`bit=3..7`，`width=1` | `(104..536, 212)` |
| 第 3 行 第 1～5 列 | `K09`～`K13` | `kivo.k18Lite.k09`～`k13` | `offset=2`，`bit=0..4`，`width=1` | `(104..536, 320)` |
| 第 4 行 第 1～3 列 | `K14`～`K16` | `kivo.k18Lite.k14`～`k16` | `offset=2`，`bit=5..7`，`width=1` | `(104..320, 428)` |
| 第 4 行 第 4～5 列 | `K17`～`K18` | `kivo.k18Lite.k17`～`k18` | `offset=3`，`bit=0..1`，`width=1` | `(428, 428)`、`(536, 428)` |

## 检查与待实机验收项

- 图形与热区交互检查可使用 [`device-hotzones.html`](device-hotzones.html?svg=../../public/device-descriptors/kivo-k18-lite.svg)。
- 待物理硬件刷写 `tools/rp2040-k18` 固件后，在 macOS 与 Windows 实机验收：免驱枚举、多台同型号按序列号隔离、多键独立按住与修饰键组合（如 `Ctrl` + `Cmd` + `A`）、OLED 常驻配置名与瞬态按键提示刷新、空闲息屏与唤醒。
