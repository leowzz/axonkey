# 设备支持包与兼容引擎

状态：第一阶段（本地声明、注册与校验）已实现。本文区分当前能力与后续设计，不能将包格式存在理解为已支持云端设备下发。

## 目标与边界

设备数量增长后，使用本地引擎已有能力的设备通过发布支持包接入；新增连接方式、系统拦截机制、语音编码或引擎操作仍需要客户端更新。所有输入处理在本机运行，设备使用不依赖联网或登录。

| 对象 | 职责 | 所有者 |
| --- | --- | --- |
| 设备支持包 | 型号身份、硬件匹配、协议规则、输入定义、图形区域、能力要求 | 官方维护，未来云端发布 |
| 设备实例 | 某一只实物的绑定、状态、当前配置 | 本机；绑定不随用户配置同步 |
| 用户映射配置 | 输入的单击、双击、长按及动作序列 | 用户；按实例和配置隔离 |
| 本地引擎 | 连接与拦截、报告解释、输入状态、手势、动作执行、原生协议适配 | 客户端 |

支持包更新不得覆盖用户映射。外观相同、名称相同不能作为复用协议的依据。

```text
支持包 ──→ 硬件匹配、报告规则、输入定义、图形
设备 → 平台输入适配器 → 报告解析 → (instanceId, inputId, value)
                                      ├→ 图形状态
                                      └→ 手势层 → 用户映射 → 本机动作执行
```

## 第一阶段交付

当前唯一声明源是 [`device-packages/builtin.json`](../device-packages/builtin.json)。它不是生成文件，应直接编辑；不要再在 TS/Rust 中复制型号清单、按键名称、遥控器几何或通用识别规则。

- 六个实例型号共用这份 JSON：RC003、CMIOT-A15、XM-BT-29、RC-313、OBE_RCU_R5、Xbox 蓝牙。
- 前端 [`src/devices/packages.ts`](../src/devices/packages.ts) 负责加载校验、注册表、运行时视图投影。型号目录中的 `buttons.ts` / `geometry.ts` / `view.ts` / `definition.ts` 保留为兼容出口，不再拥有副本。
- Rust [`src-tauri/src/devices/packages.rs`](../src-tauri/src/devices/packages.rs) 通过 `include_str!` 读取同一文件并在进程中初始化一次注册表。HID 枚举、配对记录、Windows 设备匹配、软件版本识别、实例输入校验已使用它。
- 现有 HID 解码器和语音适配器保留。回归测试核对它们的输入集合与声明完全一致。
- 系统鼠标继续是系统级输入源，所有物理鼠标共用配置；未伪装为一个按 VID/PID 识别的 HID 实例。

**这里的“运行时注册”是将 JSON 解析成运行时注册表，不是目录热加载或在线安装。** 当前应用只激活随版本打包的目录；没有新增下载接口、用户文件导入或自动扫描 app-data 目录。注册表允许独立的包 ID，现有原生会话仍有按旧 `kind` 分派的路径；新增 ID 的端到端运行要在第二阶段完成。不能仅增加一项 JSON 就宣称一种全新设备已能运行。

## 当前格式：schemaVersion 1

根对象有 `schemaVersion`、`hardware`、`packages`。所有输入 ID 和显示顺序均为稳定数据。

### hardware：硬件识别族

同 VID/PID 的软件变体引用同一个硬件族，避免靠目录顺序决定设备身份。

| 字段 | 约定 |
| --- | --- |
| `id` | 目录内唯一的硬件族标识 |
| `vendorId` / `productId` | 十进制 JSON 整数，对应 HID VID/PID；范围 0～65535 |
| `usagePage` / `usage` | 顶层 HID collection 的 Usage Page/Usage，**不是按键 usage** |
| `initialPackageId` | 仅获得硬件身份时使用的型号；必须属于本硬件族 |
| `softwareFallbackPackageId` | 软件信息缺失或未匹配时使用的型号，或 `null` |
| `hidPlatforms` | 允许走现有直接 HID 枚举的系统；不等同于设备全部平台支持情况 |
| `windows.prefixes` | 已验证的 Windows instance ID 前缀 |
| `windows.vidTokens` | Windows VID 字段的已验证表示，例如 `0416` / `010416` / `050416` |
| `windows.requireHidService` | 是否必须匹配 BLE HID 服务；服务字符串解析留在平台适配层 |
| `windows.includeHardwareId` | 是否同时读取系统 Hardware ID；RC003 保留此前的双来源规则，其他型号只看 instance ID |

当前匹配器使用 VID/PID 选择硬件族，所以目录不允许两个硬件族重复同一 VID/PID。将来支持同 VID/PID 的不同接口或连接模式时，应先扩展匹配器和校验规则，不能用重复条目碰运气。

移动遥控器保持既有行为：硬件初识为 A15，读取软件版本后区分三种型号；原生缺失/未知软件版本回退 RC-313。前端型号选择器的未知识别结果仍为 `null`，供用户选择。这是兼容现有行为，不代表推荐为所有设备猜测型号。OBE 的回退型号指向自身，保持仅凭其独立硬件身份确定型号的行为，不依赖语音编码器判断型号。

`hidPlatforms` 中 Windows 未列出的 A15/OBE 仍通过现有 Windows Quarbor 通道接入。此阶段不扩大或缩小平台能力。

### packages：型号声明

| 字段 | 约定 |
| --- | --- |
| `id` | 稳定的支持包身份；当前实例 `kind` 的值保持不变 |
| `version` | 正整数包修订号，从 1 开始；与应用版本和用户配置修订号不同 |
| `adapter` | 本地已实现的原生适配器 ID；当前保留六个旧实现名称，不接受任意代码 |
| `hardwareId` | 引用硬件族 |
| `name` / `model` | 用户可见名称和型号 |
| `softwareMarker` | 软件版本的已验证子串，或 `null`；同硬件族不能重复 |
| `capabilities.voice` | `null`、`rc003-atvv`、`a15-g7221`、`obe-sbc` |
| `capabilities.recordingModes` | A15 录音设置契约支持的模式；空数组表示不提供该设置 |
| `capabilities.defaultRecordingMode` | 兼容旧实例字段的缺省值；无该设置的设备不会因此获得录音模式能力 |
| `inputs` | 包内输入列表；型号元数据与 UI 输入列表的声明源（原生解码器仍有协议到旧 ID 的对照表，由一致性测试约束） |
| `presentation` | 图形声明，见下文 |

第一阶段的 `adapter` 表示已安装的实现，不能通过下载一个新字符串获得新能力。注册表层的包 ID 与适配器 ID 已分开，但激活新别名之前仍需迁移剩余原生分派。

`version` 当前用于声明和后续迁移准备，还未写入实例存储；**当前用户配置格式和 Store 版本不变**。第三阶段才引入激活版本、历史版本缓存及用户配置中的包引用。

### inputs 与身份规则

- `inputId` 是包内逻辑输入，不等于 HID usage、Report ID、扫描码或系统虚拟键码。
- HID 规则、图形区域、用户映射最终都引用同一个 `inputId`；实例运行寻址为 `(instanceId, inputId)`。
- 每个输入至少有 `id`、`label`、`icon`；遥控器还保留 `short`、`side`、`x`、`y` 兼容字段。
- 当前 `x/y` 是旧 UI 的百分比位置，保留原值；实际点击使用 `presentation.keyRegions` 的 SVG 坐标。不要把这两种坐标混用。后续公共渲染器再取消重复的旧位置字段。
- RC003 的 `power` 等无前缀 ID 保留；XM-BT-29 的共用键继续保留 `cmiotA15.*`，新增键保留 `xmBt29.*`。不同实例不会因此共享映射。
- 第一阶段不重命名旧输入、不迁移用户配置。将来重命名需要显式、按包版本定义的迁移，不能按字符串前缀批量猜测。
- 实例保存只接受该包实际声明的输入。A15/RC-313 以前只检查 `cmiotA15.` 前缀，现在拒绝未声明的伪造按键；现有有效配置不受影响。

### presentation 与 SVG

遥控器使用 `renderer: "remote"`，包括本地 `artwork`、`ariaLabel`、`viewBox: {width,height}`、`keyRegions`。每个区域以完整输入 ID 为键，值为 `{path, anchor: {x,y}}`，必须和 inputs 一一对应。

画布尺寸可以随设备不同；区域和底图使用相同 SVG 坐标系。SVG 负责静态外观，`RemoteControl` 负责焦点、键盘选择及状态反馈。底图内部的 `id` 不构成按键映射接口。

手柄当前使用 `renderer: "xbox"`。卡片图移到 `public/xbox-controller.svg`，编辑图仍由本地 `ControllerDiagram` 内联；`data-key`、实例级渐变 ID、可选 Share 区域继续按原约定处理。手柄输入声明已进入目录，但其区域还未迁移到公共渲染器。

图片地址当前只接受站内绝对路径，资源随应用打包。第二阶段的目标是所有设备使用“静态底图＋数据区域＋统一状态”，不会把云端 SVG 直接交给目前仅面向受信任内置资源的 `dangerouslySetInnerHTML`。

## 加载与校验

前后端各在自己的 JSON 加载入口校验一次，内部使用已确定的类型。不要在每次按键事件中反复校验完整目录。

当前校验涵盖：schema/修订版本、非空与重复 ID、硬件与型号引用、已安装适配器、软件标记、输入 ID、图标、图形尺寸和区域引用、录音模式以及资源地址。声明被拒绝时不能加载半份注册表。

两端加载器共用 [`test/fixtures/device-catalog-invalid.json`](../test/fixtures/device-catalog-invalid.json) 的错误样本。Rust 测试还将声明与真实原生解码器的输入集合对照；前端测试核对真实资源的 viewBox，并运行原有选键、配置和云恢复回归。

## 第二阶段：完整本地兼容引擎

### 声明式报告解析

按现有设备实际需求实现有限操作：

1. 报告来源、Report ID、长度、固定头与布局变体选择。
2. 字节/位偏移、位宽、大小端、有无符号读取。
3. usage 数组、单值匹配、位图、方向帽、模拟轴和扳机。
4. 最小值、最大值、中点、反向、归一化、按下与释放阈值。
5. 报告所属输入集合及完整状态/增量更新语义。
6. 原始输入保留或拦截后的回放规则。

RC003 是 16 位小端 usage 数组；A15 有键盘、Consumer 和厂商语音状态报告；XM 有短键盘报告；Xbox 有位图、轴、方向帽与独立主键报告。只下发“按键→HID 数值”不足以表达它们。

**不同报告只能更新自己拥有的输入。** A15 的 Consumer 报告不能释放方向键，Xbox 的主键报告不能释放 A/B/摇杆；非法报文与语音数据不能被解释为空按键集合。保持现有测试验证的语义。

### 会话与动作接入

- 清除 `report::decode(kind, ...)`、Windows 输入上下文、macOS 专用读入器中的型号分派，改为注册表中适配器/解析计划分派。
- 将 `&'static str` 按键状态和解码函数指针改为会话持有的包与稳定输入索引/拥有所有权的 ID，不为动态数据泄漏字符串。
- 原始按键回放传入包上下文，替换 `RemoteKey::original(button)` 对前缀的猜测；HID usage 到系统输出仍由平台层处理。
- 统一归一化输入事件；保留每实例独立状态、取消信号、动作队列、断连释放和按配置切换。
- 当前 `managed/gesture.rs` 双击窗口为 300ms，`remote_actions.rs` 为 350ms；统一前明确兼容策略，不在重构时悄悄改动手感。
- RC003 原生拦截、ATVV、G.722.1、SBC、系统输出保留为本地能力；支持包选择已有适配器。
- 界面改为按能力提供设置与触发方式，清除 `InstanceWorkspace` / `DeviceHub` 中的型号条件；保留公共工作流编辑器。
- 系统鼠标可接入同一输入/图形契约，但继续保持系统级作用域与屏幕边缘规则，不因此变成物理鼠标隔离。

建议依次以 OBE 按键、A15/XM 多报告、Xbox 位图/轴验证，最后处理 RC003 平台特例。每次迁移使用真实捕获样本和当前解码器做回归，不在测试中重写业务解析。

第二阶段验收：完成一次客户端构建后，只增加使用已支持引擎能力的本地设备包，不修改 TS/Rust/原生代码，即可识别、选键、显示输入、执行动作、保存恢复和离线运行。平台拦截与实际动作仍须硬件验收。

## 第三阶段：云端分发

在本地端到端运行成立后增加：支持包目录 API、版本与资源下载、缓存、引擎能力协商、激活版本、回退及用户配置引用。

- `schemaVersion`、包修订、客户端/适配器能力版本、用户配置修订分开管理。
- 包、图片、区域下载完整并校验后激活；运行会话绑定确定的版本，切换时释放旧输入并重建会话。
- 缺少包或引擎能力时保留用户配置并报告原因，不能按“未知输入”丢弃映射。
- 备份/云恢复先解析支持包依赖，再恢复映射；包更新不覆盖用户行为。
- 已缓存设备在断网、退出账号时继续工作。设备支持包发布和个人配置同步是两个流程。
- Relay 服务端目录和版本接口另行实现；本仓库已有用户配置同步和行为库并不代表已有协议下发。

## 修改与验证流程

1. 核对物理身份、固件、实际报文和输入含义。
2. 修改声明源；同步调整仍属于原生适配器的协议实现时，保持输入契约一致。
3. 确认输入 ID 不变、区域对应、识别族无歧义、图片实际存在。
4. 执行相关回归与构建；协议或平台接入变化还要分别进行实机验证。

```sh
node --test test/device-packages.test.mjs test/remote-control.test.mjs test/device-mapping.test.mjs test/device-profiles.test.mjs test/managed-device-discovery.test.mjs test/cloud-sync.test.mjs
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib devices
cargo test --manifest-path src-tauri/Cargo.toml --lib input_service
```

此阶段未修改 SVG 状态外观、用户映射格式、手势时长、语音协议或线上服务。已有“遥控器 mapped 类无独立显示样式”、手柄和遥控器不同按下状态接口等差异留在第二阶段统一。

## 本次验证记录（2026-11-07）

- `npm run build` 与 Windows `cargo check --lib` 通过。
- `npm run test:release`：388 项通过、35 项按环境跳过；最后的设备声明、工作区与遥控器专项回归 56 项通过。
- Windows `cargo test --lib`：276 项通过、7 项硬件测试跳过；没有进行 macOS 构建或实物按键验收。
- 本机 Cargo 测试程序初次启动遇到 `STATUS_ENTRYPOINT_NOT_FOUND`：测试 EXE 没有 Common Controls v6 激活清单，系统默认的 comctl32 不导出 `TaskDialogIndirect`。使用现有 Windows SDK `mt.exe` 为 `target/debug/deps/` 下的临时测试 EXE 加入 v6 清单后执行上述测试；没有修改应用打包或仓库构建流程。测试 EXE 重建后可能需要重新添加清单。
