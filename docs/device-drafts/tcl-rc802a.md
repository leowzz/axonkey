# TCL RC802A 图稿交接

状态：外观草稿，待采集输入协议。图稿：[tcl-rc802a.svg](tcl-rc802a.svg)。

用户已确认品牌 TCL、型号 RC802A。本图根据本轮提供的正面与侧面实拍绘制，按按键区域裁切；两张照片都未完整显示机身底端，因此没有推断完整机身长度或补品牌区。照片、水印、桌面、拉丝和光影不嵌入 SVG。

## 已完成

- 平面正面与侧视图在同一 SVG 内，保留实体键帽比例、三列排列、连续方向圆环和纵向音量摇杆；侧面改为扁平矩形底板及按键示意，不复刻厚度、坡度和层级。
- 20 个正面输入、3 个侧边输入，共 23 组稳定 ID、图形 target 和精确热区。方向环四个扇区、音量摇杆上下半区、侧边长键上下半区分别声明；图形不额外增加不存在的分割线。
- 两个软件 Logo 分别改为 `B`（bilibili）与 `K`（奇异果 TV）。其余图标保留简单线条形状，不绘制品牌 Logo。
- 顶部中央小孔与音量摇杆中央凸点仅为装饰，不是输入。正面右缘侧键凸起仅显示轮廓，交互区域统一位于旁边侧视图，避免重复输入。

## 用户提供的匹配条件

以下条件必须**全部满足**，不能只凭 VID/PID 或设备名称认定 RC802A：

| 条件 | 值 |
| --- | --- |
| Windows 硬件标识 | `DEV_VID&010416_PID&0301` |
| 用于 HID 匹配的 VID / PID | `0x0416` / `0x0301`；保留上面的原始标识，不混淆厂商源前缀与 16 位 VID |
| Device Information / Model Number String，`0x2A24` | 包含 `BT_RC802A` |
| Device Information / Manufacturer Name String，`0x2A29` | 包含 `TCL` |

SVG 中的 `ak:pending-identity` / `ak:condition` 仅保存上述接入依据，不是现有运行时支持的匹配声明。当前 v1 运行时没有这组 GATT 联合条件的声明式支持；后续接入必须实现或确认完整匹配后，才能转成启用配置。相关设备接入跟踪见 [Issue #67](https://github.com/leowzz/axonkey/issues/67)。

## 待确认和采集

- 全部按键的真实 report、usage page、usage 或厂商字段；不得沿用同 VID 或其他 TCL/CMIOT 设备的键值来补空。
- 侧边太阳图标长键分成 `sideUpper` / `sideLower`，疑似亮度调节；下方图像图标为 `sideFunction`。名称暂按位置记录，实际作用和报告待实机确认。
- 麦克风图标只证明有麦克风键，不证明 ATVV、G722.1、SBC 或其他音频链路；没有声明 `ak:voice`。
- 按下/释放、组合键、长按/重复、侧键和断连释放；身份联合条件的正反例与双实例隔离。

当前文件使用 `data-ak-status="draft"`、`status="draft"` 和 `binding="pending"`，省略 `ak:identity`、report、source 及实际键值。它是 v1 图形与元数据的作者草稿，**不能通过当前运行时的完整设备校验，也不能启用输入**。后续 skill 或 GUI 补录协议时应保留现有稳定 ID 与几何；完成验证后再移入 `public/device-descriptors/` 并运行已有生成流程。

## 交互检查

打开 [device-hotzones.html](device-hotzones.html?svg=tcl-rc802a.svg)。页面从相对路径加载本 SVG，支持显示热区、点击或键盘选中、按住反馈及列表互选。也可以加载其他 SVG、拖入文件或选择目录扫描。

若浏览器限制双击 HTML 后读取旁边的 SVG，可在页面选择 SVG/目录，或从仓库根目录启动静态服务：

```powershell
python -m http.server 8766 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8766/docs/device-drafts/device-hotzones.html?svg=tcl-rc802a.svg`。模板只引用 SVG，不保存另一份图稿；后续修改 SVG 后重新加载即可。

校验命令：

```powershell
python -X utf8 .agents/skills/axonkey-device-svg/scripts/validate_draft.py docs/device-drafts/tcl-rc802a.svg
```
