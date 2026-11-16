# TCL RC902N 图稿交接

状态：`draft`，输入绑定 `pending`。图稿：[tcl-rc902n.svg](tcl-rc902n.svg)。品牌 TCL、型号 RC902N 以及识别条件由用户提供；几何与键帽图案依据本轮正面、侧面实拍。

## 身份匹配

完整原始规则：`DEV_VID&010417_PID&0304` 附加（SoftwareRevision `0x2A28`）包含：`RC902N`。

以下两项为 **AND**，缺一不可：

| 条件 | 值 |
| --- | --- |
| Windows 硬件标识 | `DEV_VID&010417_PID&0304` |
| SoftwareRevision，GATT characteristic `0x2A28` | 包含 `RC902N` |

SVG 的 `ak:pending-identity` 原样保存硬件字符串，并用 `operator="and"` 关联软件版本条件。这只是待接入依据，不是运行时 identity；不得简化成仅 VID/PID 的可启用匹配，也不附加其他型号的条件。

## 图稿与输入

设备 ID 为 `tcl-rc902n`。下表的后缀均加 `tcl-rc902n.` 构成完整稳定输入 ID；后续补录键值、修改显示名或图标时保持 ID 不变。

| 视图 / 位置 | 稳定 ID 后缀 | 图案或含义 |
| --- | --- | --- |
| 正面第一排左、右 | `menu`、`power` | 菜单、电源 |
| 正面第二排左、中、右 | `bookmark`、`assistant`、`settings` | 书签图标、助手图标（A）、设置 |
| 正面方向环 | `up`、`right`、`down`、`left` | 四个不重叠环形扇区 |
| 方向环中央 | `confirm` | 独立圆形确认键 |
| 环下第一排左、中、右 | `back`、`home`、`tv` | 返回、主页、电视图标 |
| 环下第二排左、中、右 | `keypad`、`layers`、`tiles` | 键盘与四色点、双层菱形、方块图标 |
| 上方浅色长条左、右 | `appN`、`appY` | Netflix → N、YouTube → Y |
| 下方浅色长条左、右 | `appT`、`appP` | TCL Channel → T、Prime Video → P |
| 侧面长条上、下 | `volumeUp`、`volumeDown` | 音量＋、音量－ |
| 侧面独立圆键 | `mute` | 静音 |

共 23 个输入：正面 20、侧面 3。每个输入有一一对应的 metadata、图形 target、`data-ak-key` 和精确 `data-ak-region`；锚点使用根画布坐标。方向环、侧面音量摇杆和两条应用键只划分热区，不添加照片中不存在的分割缝。

顶部中央小孔不是按键；其具体用途未从照片确定。正面右缘露出的侧键轮廓只作装饰，输入仅登记在旁边的扁平矩形侧视图。侧视图与正面侧键大致按高度对齐，不复刻厚度和透视。品牌 Logo 不入图；助手标志改为 A，四个应用标志改为 N/Y/T/P。桌面、水印、反光和磨损均不入图。

照片未拍全机身底端，图稿在末排应用键下留边裁切；底部直线是裁切边界，不表示实际机身底端，不推测完整长度或隐藏按键。

## 待确认与采集

- `bookmark`、`tv`、`keypad`、`layers`、`tiles` 按可见图案命名；实际功能待实机确认，尤其不把菱形或方块图案直接认定为某项系统功能。
- 底部两条键帽各有两个应用标志，暂按左右两个可按区域记录四个输入；独立触发、是否为左右摇杆以及中心位置的机械行为需实机核对。
- 助手键不等于已知语音协议。实际是否支持音频、传输服务、触发方式和编解码均待采集，不声明 `ak:voice`。
- 全部输入的真实 report ID、长度、布局、usage page/usage 或厂商字段，以及按下/释放、长按重复、组合输入和断连行为均待采集；不借用其他 TCL 或相近 VID/PID 设备的数据。
- 正式接入时验证完整身份条件的正反例（同硬件标识但软件版本不包含 RC902N、版本缺失等），并完成运行时校验及设备实测。

当前草稿没有 `ak:identity`、source、report、HID usage、厂商 engine 或旧配置别名，不能通过当前运行时的完整校验，也不能启用设备。完成真实报告及适用的语音采集、运行时校验和接入后，才移入 `public/device-descriptors/` 并运行 `npm run generate:devices`。

## 检查

结构校验：

```powershell
python -X utf8 .agents/skills/axonkey-device-svg/scripts/validate_draft.py docs/device-drafts/tcl-rc902n.svg
```

交互检查：[通用热区页](device-hotzones.html?svg=tcl-rc902n.svg)。该页直接引用实际 SVG，可显示热区、点击/键盘选择、检查按住反馈。若本地文件读取受限，在页面选择此 SVG，或从仓库根目录启动：

```powershell
python -m http.server 8766 --bind 127.0.0.1
```

访问 `http://127.0.0.1:8766/docs/device-drafts/device-hotzones.html?svg=tcl-rc902n.svg`。结构校验不代替视觉检查、几何检查或实机输入采集。

本次检查结果：结构校验通过（23 个 pending 输入，正面 20、侧面 3）；浏览器渲染已对照照片检查。23 个锚点均只命中对应热区，区域包围盒相交处按 0.75 画布单位步长采样 29,520 点，未发现区域重叠。确认键热区与方向环内缘采用相同圆弧端点，避免不同圆弧拆分产生边界命中误差。通用检查页已验证方向键、侧键及应用键点击选择，以及侧键 Enter 选择与列表同步；这些检查不证明实机键值或机械行为。
