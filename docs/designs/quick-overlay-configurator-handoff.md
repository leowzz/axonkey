# 快捷交互窗配置器交接文档

独立编辑页采用方案 02「阳极铝原地直编」。选中设备布局上的键帽，即可在下方编辑该键的单击行为序列。 [方案 02 原型](quick-overlay-config-options.html)

## 进入编辑页

- 在设备实例或全局映射工作区添加「快捷交互窗」行为。选择已有快捷配置，或用「新建快捷配置」创建并关联，然后点击「配置交互窗按键」。在行为弹窗中，该入口显示为「保存并配置交互窗按键」，会先保存绑定。
- 也可以在设备的配置菜单中打开已有快捷配置，或选择「新增快捷交互配置」进入独立页。
- 点击左上角「返回」回到设备映射工作区。顶部名称在按 Enter 或离开输入框时保存，序列变更自动保存。编辑单个步骤时，在弹窗中点「保存」提交该步骤。

## 配置归属与兼容

快捷配置存储在所属设备的配置列表中，由 `quick: true` 标记。唤起键上的 `quickOverlay` 行为通过 `profileId` 引用同一设备的快捷配置。要换唤起键，在新按键关联同一套配置，然后解除旧按键的关联。编辑期间，设备仍使用原来的常驻配置。 [ADR 0004](../adr/0004-quick-interaction-overlay-profiles.md)

独立页只编辑 `TriggerBehaviors.click`。写回时保留同一按键原有的双击和长按数据。运行时继续按设备输入路径解析手势，其中滚轮等离散输入使用单击序列。 [快捷模式状态机](../../src-tauri/src/input_service/quick_mode.rs)

## 页面操作

| 区域 | 用法 |
| --- | --- |
| 顶栏 | 返回、修改配置名称、撤销与重做、实时模拟。配置菜单提供「复制配置」和「删除配置」。 |
| 设备布局 | 点击键帽切换当前按键。键帽显示按键名称、首个行为的摘要和步骤数。 |
| 单击序列 | 从左到右执行，长序列可以横向滚动。双击步骤打开编辑弹窗，右键菜单提供编辑、复制和删除。聚焦步骤后也可用 `Alt+←` 或 `Alt+→` 调整顺序。 |
| 行为库 | 支持搜索和按类别浏览。从行为库拖到键帽可追加到该键，拖到轨道可按位置插入。行为旁的 `+` 追加到当前按键，轨道末尾的「添加行为」将焦点移到行为库搜索框。 |
| 实时模拟 | 在应用内打开只读浮层，展示当前配置的单击行为，并在有唤起绑定时标出唤起与退出键。 |

需要填写参数的行为会先打开弹窗，保存时再写入序列。撤销、重做沿用设备映射的历史记录。独立页的行为库隐藏「快捷交互窗」「切换配置文件」及包含这些行为的已保存序列。 [编辑页](../../src/components/QuickOverlayConfigurator.tsx) · [行为插入与排序](../../src/components/quickOverlayConfiguration.ts)

## 布局与实现

配置器通过 `buildQuickOverlayView()` 从设备描述和按键位置计算布局，并与运行时浮层复用 `QuickOverlaySurface`。独立页会显示未配置的摇杆方向，供用户首次为这些方向添加行为。 [布局模型](../../src/components/quickOverlayModel.ts) · [共享布局组件](../../src/components/QuickOverlaySurface.tsx)

| 布局 | 适用设备 | 展示内容 |
| --- | --- | --- |
| `panel` | RC003 等遥控器 | 方向键、中心键、功能键和设备描述中存在的侧键区 |
| `matrix` | K18 Lite 等小键盘 | 按键网格与设备描述中存在的屏幕区域 |
| `controller` | Xbox 等手柄 | 肩键、中部按键、两侧按键和摇杆方向 |
| `mouse` | 系统鼠标 | 主按键、侧键和滚轮。用「鼠标触发位置」切换任意位置、上边缘、左边缘或右边缘。 |

| 代码入口 | 职责 |
| --- | --- |
| [QuickOverlayConfigurator.tsx](../../src/components/QuickOverlayConfigurator.tsx) | 键帽选择、横向序列、拖放、编辑弹窗和模拟入口。 |
| [BehaviorEditor.tsx](../../src/components/BehaviorEditor.tsx) | 创建和关联快捷配置，从行为编辑器打开独立页。 |
| [InstanceWorkspace.tsx](../../src/devices/integration/InstanceWorkspace.tsx) | 设备实例入口，使用 `changeSequence` 更新历史并保存实例配置。 |
| [AppController.tsx](../../src/app/AppController.tsx) | 全局映射入口，使用 `updateWorkflow` 更新历史和映射配置。 |
| [WorkflowToolbox.tsx](../../src/components/WorkflowToolbox.tsx) · [WorkflowStepDialog.tsx](../../src/components/WorkflowStepDialog.tsx) | 复用行为库与步骤编辑弹窗。 |
| [QuickOverlay.tsx](../../src/components/QuickOverlay.tsx) | 提供运行时浮层和应用内只读模拟共用的展示组件。 |

两条编辑入口都接收按键 ID 与更新后的 `TriggerBehaviors`。页面只替换对应按键的 `click` 序列，保存和撤销重做由各自的工作区负责。

## 验证记录

- 在浏览器验证 RC003、K18 Lite、Xbox 和系统鼠标的布局，以及拖放、插入、排序、编辑弹窗、撤销重做和实时模拟。
- 验证 RC003 的唤起绑定从语音键移到菜单键后仍引用同一配置，单击序列与旧双击、长按数据均保留。
- `npm run build`、串行发布测试和 Rust 浮层会话回归均通过。硬件唤起及前台应用注入仍待实机验收。 [Issue #87 验收记录](https://github.com/leowzz/axonkey/issues/87#issuecomment-6977063467)

[浮层样式原型](quick-overlay-options.html)
