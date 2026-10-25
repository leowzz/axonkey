# 标准手柄图形资源

本目录保存已确认的 Xbox 标准布局手柄设计资源。中心按键使用通用主页图标，不含 Xbox 品牌标志。

| 文件 | 用途 |
| --- | --- |
| `xbox-controller-keymap.svg` | 映射编辑示意图，包含按键区域、摇杆方向和部位说明，画布为 `680 × 520` |
| `xbox-controller.svg` | 设备卡片图，无编辑状态和部位说明，导出尺寸为 `240 × 196` |

两份 SVG 均内置样式、渐变和阴影，可独立显示，无原型页面 CSS、脚本或网络依赖。

## 编辑图的接入约定

- `data-key` 保留 26 个区域：`a/b/x/y`、`lb/rb/lt/rt`、`view/menu`、`ls/rs`、`dpad.up/right/down/left`、`ls.up/right/down/left`、`rs.up/right/down/left`、`guide`、`share`。
- `share` 为可选区域，默认隐藏；根 SVG 加上 `show-share` 类才显示。
- 在区域 `<g>` 上添加 `selected`、`mapped`、`pressed` 类，分别显示选中轮廓、配置标点和实际输入反馈。资源本身不预设这些运行状态。
- 静态展示可通过 `<img>` 引用。需要选键交互时应内联 SVG，由组件绑定事件、补充按钮语义、键盘焦点与输入状态。
- 定义 ID 使用 `xbox-keymap-`、`xbox-card-` 前缀；同一文档多次内联同一资源时，组件仍须生成实例级 ID，避免渐变与滤镜冲突。

原型：[交互预览](../../../docs/designs/xbox-controller.html)；[设计与接入说明](../../../docs/designs/xbox-controller/design.md)。

已通过设备实例首页接入 `045e:02e0` 蓝牙型号的发现、绑定、HID 监听和动作映射；交互组件为 `ControllerDiagram.tsx`。平台与协议范围、后续型号扩展要求见 [设备集成约定](../../../docs/DEVICE_INTEGRATION.md)。
