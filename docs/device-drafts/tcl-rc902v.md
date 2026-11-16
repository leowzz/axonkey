# TCL RC902V 图稿交接

状态：外观与精确热区草稿，全部输入待采集；尚未启用运行时设备支持。

图稿：[tcl-rc902v.svg](tcl-rc902v.svg)。品牌 TCL、型号 RC902V 和匹配条件均由用户提供，外观依据 2026-11-11 本轮正面实拍。

## 图稿与输入

共 28 个正面输入。方向圆环拆成四个不重叠环形扇区，确认键独立；音量长键拆成上下半区；底部三条双色应用标识键各拆为左右两区。连续键帽不额外绘制分割线，每个输入的 metadata、图形 target、精确 region 和根坐标锚点对应一致。

顶部中央小孔仅作装饰，实际用途不据照片判定。照片未拍到机身底端，因此保留顶部轮廓并在最后一排按键下方留边裁切，不推断整机长度。侧面未展示，不声明侧键。图稿不含照片、水印、桌面、磨损、光影或品牌 Logo。

助手 Logo 替换为 A；底部应用 Logo 依次替换为 N / P、G / M、Y / T。这些字母只用于图稿标识，不改变稳定输入 ID。

| 稳定输入 ID | 标签 | 视图 |
| --- | --- | --- |
| `tcl-rc902v.mute` | 静音 | front |
| `tcl-rc902v.power` | 电源 | front |
| `tcl-rc902v.bookmark` | 书签图标键 | front |
| `tcl-rc902v.assistant` | 助手键 | front |
| `tcl-rc902v.settings` | 设置 | front |
| `tcl-rc902v.up` | 上 | front |
| `tcl-rc902v.right` | 右 | front |
| `tcl-rc902v.down` | 下 | front |
| `tcl-rc902v.left` | 左 | front |
| `tcl-rc902v.confirm` | 确认 | front |
| `tcl-rc902v.back` | 返回 | front |
| `tcl-rc902v.home` | 主页 | front |
| `tcl-rc902v.tv` | 电视图标键 | front |
| `tcl-rc902v.input` | 信号源 | front |
| `tcl-rc902v.volumeUp` | 音量加 | front |
| `tcl-rc902v.channelUp` | 频道加（P+） | front |
| `tcl-rc902v.menu` | 菜单 | front |
| `tcl-rc902v.volumeDown` | 音量减 | front |
| `tcl-rc902v.channelDown` | 频道减（P−） | front |
| `tcl-rc902v.layers` | 叠层图标键 | front |
| `tcl-rc902v.keypad` | 键盘和彩色点图标键 | front |
| `tcl-rc902v.tiles` | 方格图标键 | front |
| `tcl-rc902v.netflix` | Netflix | front |
| `tcl-rc902v.primeVideo` | Prime Video | front |
| `tcl-rc902v.guard` | Guard | front |
| `tcl-rc902v.media` | Media | front |
| `tcl-rc902v.youtube` | YouTube | front |
| `tcl-rc902v.tclChannel` | TCL Channel | front |

## 完整匹配条件

用户原始条件：`DEV_VID&010417_PID&0304` 附加（SoftwareRevision 0x2A28）包含：`RC902V`。

以下两项为 **AND**，必须同时满足：

| 条件 | 值 |
| --- | --- |
| 硬件标识 | `DEV_VID&010417_PID&0304` |
| SoftwareRevision / Software Revision String，`0x2A28` | 包含 `RC902V` |

SVG 的 `ak:pending-identity` 原样保存硬件标识与附加条件，仅用于后续接入；未创建可启用的 `ak:identity` 或 `ak:match`。不能降级为只匹配 VID/PID，也不能用相近型号或名称替代这组联合条件。

## 待确认和采集

- `bookmark`、`layers`、`keypad`、`tiles` 和 `tv` 按可见图标命名，实际功能由实机确认。A 键按助手标识记录，不据此声明语音能力。
- 三条应用键按左右两个标识分别建立输入，需实机确认各半区独立触发和实际报告。
- 全部按键的按下、释放、长按/重复、组合键、真实 report ID、长度、usage page/usage 或厂商字段；不借用其他 TCL 设备协议。
- 助手键是否关联音频，以及真实服务、特征、控制消息和音频编码；均待采集，没有声明 `ak:voice`。
- 后续身份匹配验证应覆盖：两项均满足；硬件标识相同但软件型号不同或读取失败；只有软件型号满足。再验证断连释放、原键转发及同型号双实例隔离。

当前使用 v1 图形制作子集，根和设备均标记 `draft`，28 个输入全部 `binding="pending"`。未知 source、报告、HID 值、engine、语音能力及 legacy-key 均省略。当前运行时拒绝该不完整定义是预期结果；图稿校验不代表设备已能发现、绑定或接收输入。

完成真实协议采集、完整身份条件接入和运行时验证后，保持稳定 ID 与精确路径，再移入 `public/device-descriptors/` 并运行 `npm run generate:devices`。

## 查看和验证

交互检查：[device-hotzones.html](device-hotzones.html?svg=tcl-rc902v.svg)。使用热区开关、点击/键盘选中和按下反馈核对真实路径。页面引用原 SVG，不内嵌另一份图稿。

如浏览器限制本地相对文件读取，可用页面的“打开 SVG”选择图稿，或在仓库根目录运行：

```powershell
python -m http.server 8766 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8766/docs/device-drafts/device-hotzones.html?svg=tcl-rc902v.svg`。

结构校验：

```powershell
python -X utf8 .agents/skills/axonkey-device-svg/scripts/validate_draft.py docs/device-drafts/tcl-rc902v.svg
```

2026-11-11 验证结果：结构校验通过（28 个 pending 输入，均为 front）；浏览器渲染对照照片检查完成。使用原 SVG 路径的 `isPointInFill` 检查，28 个锚点全部在对应区域内；避开共享边界的 77,268 个采样点未发现热区重叠，方向环 6,120 个内部采样点均恰好命中一个扇区。通用检查页的热区显示、音量加点击选择及频道加键盘 Enter 选择通过。采样验证不替代实物按压和报告采集。

