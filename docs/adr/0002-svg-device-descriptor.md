# SVG 设备描述作为设备类型协议

状态 `accepted`（分阶段实施）

对应 [Issue #58](https://github.com/leowzz/axonkey/issues/58)。

## 背景

当前遥控器 SVG 只承载展示图形和定位区域，按钮 ID、设备匹配、HID 报告布局和语音解码分散在 TypeScript 与 Rust 支持包中。A15、XM-BT-29、OBE-RCU-R5 和 RC003 的同名按键使用不同的 usage page、report ID、报告布局甚至厂商包；仅把一个整数放进 SVG 会产生误匹配。未来设备定义可能由云端下发，因此还必须限制不可信 SVG 的执行边界。

同时，Axonkey 已经按 `instanceId` 管理物理设备、绑定、后台会话和配置。用 SVG 型号或 VID/PID 取代实例会破坏同型号多设备隔离。

## 决定

采用版本化的 `axonkey.device/1` SVG 描述协议：

- 一个 SVG 同时包含图形和 `urn:axonkey:device:1` 元数据，声明稳定输入 Key、`data-ak-key` 交互区域、身份匹配、报告布局、HID source、能力和迁移别名。
- Source 使用结构化 union：标准 HID 使用 `page + usage + report`，厂商报告使用白名单 engine 加字段/长度/分片参数，轴和手柄输入使用位域、轴和帽开关描述。
- SVG 是数据和资源，不执行脚本、网络请求或任意解码代码。平台驱动、权限、独占策略、实例绑定、语音连接/解码/输出仍由应用后端实现。
- 配置持久化使用 `(instanceId, stableKey)`，并保留 `legacy-key` 迁移别名。未知主版本、缺少必需能力或报告校验失败时保留配置但拒绝启用；可选能力缺失只禁用该能力。
- 用户行为序列不嵌入 SVG。SVG 只描述输入和原始转发，行为继续复用现有 profile DSL。

## 取舍和影响

优点是设备定义可以随图形一起分发，通用引擎可在不改 UI 按钮表的情况下发现输入；报告 ID、usage page、端序、槽位和 vendor state 也能被准确表达。代价是需要安全 XML 校验器、source union 和白名单 engine 注册表，且旧设备必须通过 alias/适配器迁移。纯 SVG 不能替代平台 HID/GATT 权限和驱动能力，因此“文件可解析”不等于“设备可运行”。

该决定保留 `docs/adr/0001-windows-rc003-input-by-device-instance.md`：SVG 的 identity 只识别支持包候选，Windows RC003 仍按绑定的设备实例安装和连接 Quarbor 驱动。

## 实施进度

`src-tauri/src/devices/device_descriptor.rs`、`engine.rs` 和 `descriptor_registry.rs` 已贯通六种现有设备。设备身份、软件版本细分、报告布局、原始 HID、语音能力和配置热区以 `public/device-descriptors/` 为来源，移除旧的设备按键表与解码回退。

前端在构建时生成索引，统一渲染 SVG 图稿与精确热区；采用构建生成是为了保留同步类型及现有配置入口，不在页面运行时增加异步 XML 加载。Windows、managed 和 macOS 输入路径复用同一解析/状态语义，平台输出与音频后端保留为注册适配器。

已有配置保持原 Key，内部 stable ID 在配置边界转为 `legacy-key`。云端分发、运行时下载、定义版本持久化与显式升级迁移留待后续实施。

TCL 接入继续沿用上述边界：`ak:match` 的 `information-required="true"`、`model-contains`、`manufacturer-contains` 和 `software-contains` 声明联合条件；平台层只负责读取相应 GATT 特征。条件缺失或不符时不能绑定、安装到已保存目标或启动输入。

显式 `binding="pending"` 的输入可没有 source，用于保留已绘制、尚缺真实按下采集的单个按键；引擎对此不生成边沿，其他缺失 source 的输入继续拒绝解析。RC802A 的 `tcl-rc802a.ico`（仅声明 `hold` 模式）与 RC902N/RC902V 共用的 GATT `tcl-rc902v-atvv`（绑定各自 `.assistant` 键、以 On-request `0x00` 协商并声明 `hold click` 两种触发模式）均为原生白名单音频适配器。
