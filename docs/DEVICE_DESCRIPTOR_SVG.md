# SVG 设备描述协议

状态：`implemented-bundled`，对应 [Issue #58](https://github.com/leowzz/axonkey/issues/58)。

本文定义 `axonkey.device/1`。它把设备图形、设备身份、输入区域、实际输入报告和能力声明放在同一个 SVG 中，供发现层、映射页和通用驱动引擎读取。六种已支持设备已通过内置 SVG 提供身份、报告、输入和热区；前端和各输入入口共用这些定义。平台驱动、系统事件与语音编解码仍由应用提供。

网络设备、连续触摸和独立音频输入的后续草案见[设备输入源设计](DEVICE_INPUT_SOURCES.md)及 [ADR 0003](adr/0003-transport-independent-device-input.md)。该扩展拟使用 `axonkey.device/2`，尚未实现，不改变本文的 v1 契约。

从实拍照片准备尚未采集键值的设备，使用仓库 [axonkey-device-svg skill](../.agents/skills/axonkey-device-svg/SKILL.md)。这类图稿存放在 `docs/device-drafts/`，只复用本文的图形、稳定 ID 和热区格式；标记为 `draft`，省略实际 report/source，不是当前运行时可启用的完整 v1 描述符。示例见 [TCL RC802A](device-drafts/tcl-rc802a.md)。

## 1. 边界

SVG 描述的是**设备类型**，不是某一只实物，也不是用户的映射配置。

- SVG 负责：型号身份、匹配条件、图形、稳定输入 Key、输入报告解析、原始按键转发、能力和平台要求。
- 设备实例仍由 `instanceId`、绑定身份、连接状态和权限组成。运行时寻址始终是 `(instanceId, stableKey)`，不能用型号、VID/PID 或 SVG 文件名代替实例。
- 用户行为序列、配置文件、激活配置和应用绑定继续保存在实例配置中。SVG 可以声明默认的“保留原按键”行为，但不能写入另一只设备的用户配置。
- SVG 是声明文件，不执行脚本，不发起网络请求，也不能携带任意解码代码。厂商特殊协议只能引用应用内置且白名单中的 engine。

这样既能让一个文件完整描述“如何识别和读懂设备”，又不会破坏现有的多实例隔离和配置恢复。

## 2. 版本和安全

根元素必须同时有 XML 命名空间和可快速检查的版本属性：

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:ak="urn:axonkey:device:1"
     viewBox="0 0 516 1255"
     data-ak-schema="axonkey.device/1"
     data-ak-device="xiaomi.rc003"
     data-ak-revision="1">
```

- `data-ak-schema` 的主版本决定解析契约。未知主版本只能作为图片预览，不能启用输入。
- `data-ak-revision` 是同一设备定义的内容版本。小版本兼容时可以继续使用，改变输入含义时必须递增并提供迁移别名。
- `data-ak-device` 是稳定的型号 ID，不是实例 ID。
- 根部三个 `data-ak-*` 值必须与 `ak:device` 的 schema、`id` 和 `revision` 一致；缺失或冲突时拒绝启用该定义。
- 解析器只允许 SVG 图形、`metadata` 和 `urn:axonkey:device:1` 元数据。拒绝 `<script>`、事件属性、外链 `<image>`/`<use>`、外链字体和未知命令式内容；云端文件先在非浏览器 XML 解析器中校验，再交给 UI 显示。
- `metadata` 中未知的 `ak:*` 子元素可以保留并忽略。标记为 `required="true"` 的未知能力、报告编码或 engine 必须使该设备进入“定义不受支持”，不能静默按相似设备运行。

## 3. 元数据结构

`metadata` 中只使用以下声明块：

```xml
<metadata>
  <ak:device schema="axonkey.device/1" id="xiaomi.rc003" vendor="Xiaomi" model="RC003"
             revision="1" display-name="小米 RC003">
    <ak:identity>
      <ak:match transport="bluetooth-hid"
                vid="0x2717" pid="0x32B8"
                service="00001812-0000-1000-8000-00805F9B34FB"
                required="true" />
    </ak:identity>
    <ak:reports>…</ak:reports>
    <ak:inputs>…</ak:inputs>
    <ak:capabilities>…</ak:capabilities>
  </ak:device>
</metadata>
```

### 3.1 身份匹配

`ak:identity` 可以有多个 `ak:match`；不同 `match` 是 OR，同一 `match` 的属性是 AND。可用属性包括：

| 属性 | 说明 |
| --- | --- |
| `transport` | `usb-hid`、`bluetooth-hid`、`bluetooth-gatt`、`quarbor-universal` |
| `vid`、`pid` | `0x` 十六进制整数；`|` 分隔同一字段的多个等价值 |
| `service`、`interface`、`collection` | 具体 HID/GATT 服务、接口或 collection 标识 |
| `usage-page`、`usage` | 用于区分复合 HID 接口，不能单独代替 VID/PID |
| `windows-prefix` | Windows 实例节点类型前缀，例如 `BTHLEDEVICE` 或 `HID\` |
| `software-contains`、`software-fallback` | 相同硬件 ID 的设备用 Device Information 软件版本细分；未识别时只采用明确声明的兼容默认型号 |
| `revision` | 仅当设备报告的固件/硬件版本必须参与匹配时使用 |
| `serial-policy` | `stable`、`temporary`、`reject-ambiguous`；默认 `reject-ambiguous` |

匹配成功只说明“这是该支持包的候选设备”。绑定仍由用户选择明确的物理设备；两个同型号设备不能因为匹配条件相同而共享实例。

### 3.2 报告声明

`ak:reports` 描述输入、输出和语音触发所需的报告布局。每个报告有稳定的 `id`，按键通过 `report` 属性引用它。

```xml
<ak:report id="keyboard"
           direction="input"
           report-id="0x01"
           length="7"
           encoding="le-u16-slots"
           usage-page="0x07"
           payload-offset="1"
           slot-width="2"
           slot-count="3"
           endian="little" />
```

`encoding` 是有限枚举，第一版定义：

- `boot-keyboard`：修饰位、保留字节和 6 个 1 字节 usage 槽。
- `le-u16-slots`：可选 report ID 后，由小端 16 位 usage 槽组成；零值是空槽。
- `le-u16-single`：可选 report ID 后的单个小端 16 位值。
- `bit-field`：固定偏移和位宽的布尔或整数域。
- `axis-u16`：小端/大端无符号轴值，配合 `min`、`max`、`deadzone` 和 `threshold`。
- `hat-8`：8 方向帽开关，配合 `neutral` 和 `direction-map`。
- `vendor-state`：只能与白名单 `engine` 一起使用；不接受脚本或表达式。
- `gatt-stream`：交给白名单 `engine` 的不透明音频/数据流，可由 GATT 承载，也可声明 HID `report-id`。

报告必须写清 `report-id` 是否占据首字节、有效载荷偏移、长度、端序、槽数或位域。不能只写一个 usage 数字，也不能假设所有设备的同名 report 布局相同。

`prefix` 可声明从首字节开始的固定前缀（空格分隔的 `0xNN`），`prefix-not` 排除该前缀以区分相同长度的报告，`state-max` 限制厂商状态上界，`zero-tail-offset` 声明该偏移到包尾必须为零。A15 的 F8 包因此无需设备专用判断。

同一物理状态的不同线格式应声明相同的 `state-group`，例如 RC003 的带 ID、无 ID、boot 和三字节头变体，或 XM 的 4/9 字节键盘包。新报告替换该组状态；不同组互不清空，多 source 的值取最大值，再应用进入/释放阈值。未识别或格式错误的包保持已有状态，断连和报告丢失由会话显式释放。

### 3.3 输入 Key 和图形区域

每个可配置输入都有一个稳定、设备命名空间内唯一的 `id`。建议使用 `<厂商>.<型号>.<语义>`，例如 `xiaomi.rc003.voice`；历史 ID 放到 `legacy-key`，只用于迁移和读取旧配置。

```xml
<ak:input id="xiaomi.rc003.power"
          label="电源键"
          kind="button"
          target="#power"
          legacy-key="power"
          report="keyboard"
          page="0x07"
          usage="0x66"
          original="true" />
```

- `id` 是配置持久化的 Key；`target` 只是在当前 SVG 内定位图形区域，不能作为持久化 ID。
- `legacy-key` 是以空白分隔的别名列表（单个别名时如示例所示），一个别名不能指向两个输入。XM-BT-29 复用 A15 的旧共享按键时，必须保留原别名，新增数字键使用自己的命名空间。
- `kind` 为 `button`、`axis`、`trigger`、`hat` 或 `encoder`。只有 `button` 默认进入单击/双击/长按手势；其他类型必须声明可用触发方式。
- `original="true"` 表示单击未配置时保留原始输入；`original="false"` 表示未配置时丢弃。原始转发只能使用应用支持的 HID 输出路径。
- `original` 未写时按 `false` 处理，避免新定义无意中把物理输入透传到系统。
- 图形层用 `data-ak-key` 标注交互区域，不依赖易变的 SVG `id` 或 `<title>`：

```xml
<g id="power" data-ak-key="xiaomi.rc003.power"
   data-ak-role="input" aria-label="电源键" tabindex="0" role="button">
  …
</g>
```

生产内置 SVG 同时保存一份透明的精确配置热区，避免图形的装饰描边或图标影响命中：

```xml
<g data-ak-regions="true" fill="transparent" pointer-events="none">
  <path data-ak-region="xiaomi.rc003.power"
        data-ak-anchor="132 162"
        d="M 78.5 162 a 53.5 53.5 0 1 0 107 0 a 53.5 53.5 0 1 0 -107 0" />
</g>
```

`data-ak-region` 对应 stable input ID，`d` 为实际热区；可带 SVG `transform`，锚点始终使用根画布坐标。`ak:input` 的 `short`、`icon`、`order` 提供现有映射页面所需的简称、应用图标 ID 和显示顺序。构建脚本从 SVG 生成 TypeScript 索引，通用渲染器用原路径绘制透明命中面、选中轮廓和按下反馈；不手写另一份设备几何数据。

交互区域必须有 `aria-label`；渲染器从对应 `ak:input label` 注入，不把 SVG `id` 当作可访问名称。一个 Key 可以有一个主区域和多个 `data-ak-role="input"` 子区域，但解析后必须合并为一个输入。没有图形的输入仍可存在于元数据中（例如系统鼠标或隐藏的报告按键）。没有 `target` 和 `data-ak-region` 的隐藏输入不生成映射图热区，完整输入仍由 Rust 解析器保留。

### 3.4 标准 HID、厂商值和输出

标准输入用 `(page, usage, report)` 三元组；同一 Key 可以有多个 `ak:source`，用于不同固件报告，但必须带互斥的报告条件：

```xml
<ak:source report="keyboard" page="0x07" usage="0x66" />
<ak:source report="consumer" page="0x0C" usage="0x00E9" />
```

`ak:input` 上的 `report`、`page`、`usage` 是单个 `ak:source` 的简写，适用于只有一个物理来源的按键；需要多个来源、字段匹配或阈值时使用显式 `ak:source`。

厂商值使用字段匹配，不能伪装成 HID usage：

```xml
<ak:source report="voice-edge" engine="cmiot-a15.voice-edge"
          field="state" equals="1" />
```

`engine` 只允许应用注册的解码器 ID，例如 `rc003-atvv`、`cmiot-a15.voice-edge`、`cmiot-a15.g7221`、`obe-rcu-r5.sbc`。SVG 只提供白名单参数（报告 ID、长度、分片数、采样率等）；蓝牙连接、权限、解码器、音频输出和设备独占仍由平台后端提供。

SVG 不内嵌用户行为序列。`key`、`shortcut`、鼠标和文本行为继续使用现有配置 DSL；通用引擎把输入 Key 交给现有手势和动作层，再按平台能力产生标准 HID、虚拟输入或原始转发。

### 3.5 语音能力

语音是可选能力，不默认等同于语音按键：

```xml
<ak:voice id="voice"
          trigger-key="xiaomi.rc003.voice"
          transport="gatt"
          service="AB5E0001-5A21-4F05-BC7D-AF01F617B664"
          transmit="AB5E0002-5A21-4F05-BC7D-AF01F617B664"
          audio="AB5E0003-5A21-4F05-BC7D-AF01F617B664"
          control="AB5E0004-5A21-4F05-BC7D-AF01F617B664"
          engine="rc003-atvv"
          sample-rate="16000"
          required="false" />
```

`trigger-modes` 以空格分隔允许的录音模式：`hold` 或 `click`。当前 A15 支持两者，XM/RC313/OBE 保持 `hold`。

`transport` 为 `gatt`、`hid-report` 或 `none`。GATT 声明应给出服务和控制、发送、音频 characteristic；HID 语音则给出 report 布局和 edge source。`required="true"` 时平台没有对应后端，设备不可启用；可选语音则只显示“语音不可用”，按键映射仍可使用。语音转文字不属于设备协议，由系统输入法或调用方负责。

## 4. 现有设备的物理输入登记

以下表格是从当前 Rust 解码器和测试提取的 v1 迁移基线。十六进制值必须按表中的 usage page、report ID 和布局一起使用。

### RC003

匹配：`bluetooth-hid`，VID `0x2717`，PID `0x32B8`，HID service `0x1812`。键盘输入是 report ID `0x01` 的小端 16 位 usage 槽；Windows Universal 还接受无 ID 的 6 字节 payload、8 字节 boot keyboard、带三字节头的 9 字节变体和带 ID 的 9 字节四槽报告；最后两种由前缀条件区分。

| Key（迁移别名） | Page | Usage | Report | 原始转发/备注 |
| --- | ---: | ---: | ---: | --- |
| `voice` | `0x07` | `0x003E` | `0x01` | 另有 RC003 ATVV GATT 语音能力 |
| `back` | `0x07` | `0x00F1` | `0x01` | macOS 原始返回键 |
| `confirm` | `0x07` | `0x0028` | `0x01` |  |
| `tv` | `0x07` | `0x0035` | `0x01` |  |
| `home` | `0x07` | `0x004A` | `0x01` |  |
| `right` / `left` | `0x07` | `0x004F` / `0x0050` | `0x01` |  |
| `down` / `up` | `0x07` | `0x0051` / `0x0052` | `0x01` |  |
| `menu` | `0x07` | `0x0065` | `0x01` |  |
| `power` | `0x07` | `0x0066` | `0x01` |  |
| `volumeUp` / `volumeDown` | `0x07` | `0x0080` / `0x0081` | `0x01` | 保留原始时使用媒体事件 |

### CMIOT-A15 与 RC-313

匹配：`bluetooth-hid`，VID `0x0416`、`0x010416` 或 `0x050416`，PID `0x0300`，HID service `0x1812`。RC-313 当前复用同一份报告和语音协议。

| Key | Page | Usage/值 | Report | 布局 |
| --- | ---: | ---: | ---: | --- |
| `cmiotA15.power`、`up`、`left`、`right`、`down`、`menu` | `0x07` | `0x66`、`0x52`、`0x50`、`0x4F`、`0x51`、`0x65` | `0x01` | 9 字节 boot keyboard，usage 槽为 1 字节 |
| `cmiotA15.channelUp` / `channelDown` | `0x07` | `0x4B` / `0x4E` | `0x01` | 同上 |
| `cmiotA15.confirm` | `0x0C` | `0x0041` | `0x03` | 3 字节，report ID + 小端 16 位值 |
| `cmiotA15.back` / `home` | `0x0C` | `0x0224` / `0x0223` | `0x03` | 同上 |
| `cmiotA15.volumeUp` / `volumeDown` | `0x0C` | `0x00E9` / `0x00EA` | `0x03` | 同上 |
| `cmiotA15.mute` / `settings` / `m` | `0x0C` | `0x00E2` / `0x00EB` / `0x00F0` | `0x03` | 同上 |
| `cmiotA15.voice` | — | 状态 `0`/`1` | `0xF8` | 21 字节 vendor report `[F8 82 03 state …]`，不是 HID usage |

A15 的按键 edge report `0xF8` 固定为 21 字节：`bytes[0] = 0xF8`、`bytes[1..3] = [0x82, 0x03]`，`bytes[3]` 是 0/1 状态，其余字节必须为零。语音音频是 report `0xFC`、21 字节、三片重组的厂商流：`bytes[1]` 和 `bytes[2]` 组成小端 group，`bytes[3]` 为 0、1、2 的 fragment，`bytes[5..21]`（Rust 半开区间）为 16 字节负载；三包拼成 48 字节，其中前 40 字节交给应用内置 `cmiot-a15.g7221` 解码器，尾部 8 字节保留。它与按键 edge 分开声明。

### XM-BT-29

XM-BT-29 复用 A15 的型号匹配、公共 Key 和报告布局；以下是新增输入。旧的 A15 公共按键别名必须继续可读。

| Key | Page | Usage | Report |
| --- | ---: | ---: | ---: |
| `xmBt29.digit1`…`digit9` | `0x07` | `0x1E`…`0x26` | `0x01` |
| `xmBt29.digit0` | `0x07` | `0x27` | `0x01` |
| `xmBt29.delete` | `0x0C` | `0x00FC` | `0x03` |

### OBE-RCU-R5

匹配：`bluetooth-hid`，VID `0x1D5A`、`0x011D5A` 或 `0x051D5A`，PID `0xC081`，HID service `0x1812`。report `0x01` 使用 page `0x07` 的 1 字节 boot keyboard 槽。

| Key | Usage |
| --- | ---: |
| `obeRcuR5.power`、`locate` | `0x66`、`0x72` |
| `obeRcuR5.up`、`left`、`right`、`down` | `0x52`、`0x50`、`0x4F`、`0x51` |
| `obeRcuR5.confirm`、`home`、`back` | `0x28`、`0x4A`、`0x29` |
| `obeRcuR5.voice` | `0x73` |
| `obeRcuR5.volumeUp`、`volumeDown` | `0x80`、`0x81` |

OBE 语音音频是 report `0x1E`、总长 61 字节（含 report ID、payload 60 字节）的厂商流，分成三个加密的 20 字节块，使用白名单 `obe-rcu-r5.sbc` 解密并解码为 128 个采样；不要把它当作 A15 的 `0xFC` 音频。

### Xbox Wireless Controller（说明 union 扩展）

匹配：蓝牙 VID `0x045E`/`0x0002045E`、PID `0x02E0`。它不是键盘 usage 列表：report 1 长 16 字节，左/右摇杆在偏移 1/3/5/7，LT/RT 在偏移 9/11，帽开关在偏移 13，普通按键在偏移 14/15 的 bit 0…9；report 2 `[0x02, 0x01]` 的 bit 0 是 Guide。SVG 应使用 `bit-field`、`axis-u16` 和 `hat-8` source，不能为了复用按钮表伪造一个 usage 值。

Report 1 的 bit 顺序为 `A、B、X、Y、LB、RB、View、Menu、LS、RS`。摇杆和扳机都是小端 16 位值；扳机有效范围为 0…1023，方向/扳机进入阈值 55%、释放阈值 35%。帽值按 `up=[8,1,2]`、`right=[2,3,4]`、`down=[4,5,6]`、`left=[6,7,8]` 解码，0 是中立。这里的偏移、位宽和滞回参数必须由 SVG 明确声明，不能只记录 `xbox.a` 这样的语义名称。

## 5. 兼容、迁移和失败结果

配置记录保存 `deviceId`、`stableKey`、`schemaMajor` 和 `definitionRevision`。加载新定义时按以下顺序处理：

1. 先用 `stableKey` 查找；找不到时只按该输入声明的 `legacy-key` 查找。
2. 别名必须唯一且属于同一 `deviceId`。不能按 label、位置、图形 `id` 或数组顺序猜测迁移。
3. 匹配成功后记录当前 revision；旧配置保留原行为序列。定义只改变图形时无需迁移，改变物理 source 时要求显式迁移并显示差异。
4. 未知主版本、必需 engine 缺失、报告布局校验失败或身份匹配不完整时，保留配置并显示“设备定义不受支持”；不启动监听，不把输入交给相似设备解码器。
5. 可选能力缺失只禁用该能力。例如平台没有 ATVV 音频后端时，RC003 的映射仍可使用，语音状态显示为不可用。

SVG 更新不得改变已保存 Key 的含义。删除 Key、重用 Key 或修改 alias 指向时必须递增 revision，并提供显式迁移表；旧 revision 的配置可以回退到原定义。

## 6. 接入顺序和验证

当前内置描述符位于 `public/device-descriptors/`，Rust 通过 `include_str!` 固定打包并在首次使用时解析一次。所有报告入口使用共享报告引擎；旧设备专用按键表和解码回退已删除。旧 Key 由 `legacy-key` 映射保持兼容，描述符解析失败时不启动相似设备解码器。

前端运行 `npm run generate:devices`，由 `scripts/generate-device-descriptors.mjs` 生成 `src/devices/generatedDescriptors.ts`。`dev`、`dev:tauri` 和 `build` 自动执行生成，测试检查索引是否与 SVG 一致。不要手改生成文件。六种设备都通过同一个 `RemoteControl` 渲染，RC313 使用自己的描述符，Xbox 的多键、轴和帽输入复用同一状态反馈。型号识别、语音控件、录音模式和扳机读数也读取生成的身份、能力与输入声明，不再维护型号判断表。

当前已有配置继续保存原有兼容 Key，不重写用户映射；引擎内部使用 stable ID，在既有配置和事件边界转换为兼容 Key。配置入口接受 stable ID 或任一别名，执行前统一为首个兼容别名；同一输入同时配置多个名称时拒绝保存，避免动作被静默覆盖。上文第 5 节的定义版本持久化、云端下载和动态更新属于后续分发流程，不是本轮内置迁移的前提。

通用引擎按以下边界接入现有代码：

1. 安全解析并校验 SVG，生成 `DeviceSupportPackage`、`RemoteView` 和输入 source 描述。
2. 发现层只使用 `identity` 生成候选；实例绑定、驱动安装、权限和句柄生命周期仍沿用 `docs/DEVICE_INTEGRATION.md`。
3. 原生输入服务把报告解码成 `(instanceId, stableKey, pressed/value)`，交给现有手势和动作队列。
4. 平台后端实现 `keysend`、虚拟输入、原始转发和白名单语音 engine；SVG 不携带平台代码。
5. 先用 RC003 完成“加载 SVG → 发现/绑定 → 图上选键 → 保存/恢复映射 → 真实 report 触发”；随后用 A15/XM/OBE 覆盖多 report、vendor edge 和语音差异。每种设备至少测试两只同型号实例的配置隔离、断连释放和定义更新。

现有 `keymap.get` 可以继续返回 `artwork.svg`、`viewBox` 和区域坐标；迁移后增加已验证的 `descriptor.schema`、`descriptor.revision` 和 `keys[].stableKey/source`，同时保留旧的 `keys[].id` 作为兼容字段。

