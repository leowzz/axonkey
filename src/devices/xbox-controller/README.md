# 标准手柄图形资源

本目录保存已确认的 Xbox 标准布局手柄设计资源。中心按键使用通用主页图标，不含 Xbox 品牌标志。

`inputs.ts` 从协议 SVG 的生成索引导出输入与视图，`definition.ts` 定义实例支持包，`index.ts` 提供型号公开出口。

| 文件 | 用途 |
| --- | --- |
| `public/device-descriptors/xbox.svg` | 协议元数据、按键、摇杆方向及交互热区，画布为 `680 × 520` |
| `xbox-controller.svg` | 设备卡片图，无编辑状态和部位说明，导出尺寸为 `240 × 196` |

两份 SVG 均内置样式、渐变和阴影，可独立显示，无原型页面 CSS、脚本或网络依赖。

## 编辑图的接入约定

- `data-key` 保留 26 个区域：`a/b/x/y`、`lb/rb/lt/rt`、`view/menu`、`ls/rs`、`dpad.up/right/down/left`、`ls.up/right/down/left`、`rs.up/right/down/left`、`guide`、`share`。
- `share` 为可选区域，默认隐藏；根 SVG 加上 `show-share` 类才显示。
- `ak:input` 声明输入名称和行为 ID，`data-ak-region` 路径声明完整热区，`data-ak-anchor` 使用根画布坐标；摇杆和方向区的路径可携带 SVG `transform`。
- 静态展示通过 `<img>` 引用；映射页由通用 `RemoteControl.tsx` 叠加同一协议 SVG 的热区，统一提供选中、按下、已映射、悬停、键盘焦点和输入状态。
- 修改协议 SVG 后运行 `npm run generate:devices`，同步提交生成索引；开发和构建也会自动重新生成。

原型：[交互预览](../../../docs/designs/xbox-controller.html)；[设计与接入说明](../../../docs/designs/xbox-controller/design.md)。

已通过设备实例首页接入 `045e:02e0` 蓝牙型号的发现、绑定、HID 监听和动作映射。平台与协议范围、后续型号扩展要求见 [设备集成约定](../../../docs/DEVICE_INTEGRATION.md)。
