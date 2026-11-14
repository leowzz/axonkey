---
name: axonkey-device-capture
description: 连接遥控器、小键盘、手柄等新物理设备，安全挂载或恢复 Quarbor 拦截驱动，通过 axonkey-cli capture 引导逐键采集原始 HID 按下与松开报文，并将待采集 SVG 草稿编译为通过引擎校验的 axonkey.device/1 设备描述文件。不用于凭照片从零绘制 SVG 外观（绘图先用 axonkey-device-svg）。
---

# Axonkey 新设备 HID 采集与描述符编译

在物理设备已连接本机的前提下，完成从候选设备识别、安全驱动挂载、逐键原始报文采样到 `axonkey.device/1` 描述符编译与校验的闭环。`axonkey-cli capture` 直接在 CLI 进程内执行原生采集逻辑，不依赖 Axonkey 桌面界面运行；若桌面端同时打开了同一设备的采集会话或独占管道，先关闭或暂停桌面端采集再执行 CLI。

先读 [SVG 设备描述协议](../../../docs/DEVICE_DESCRIPTOR_SVG.md)、[新设备接入文档](../../../docs/DEVICE_INTEGRATION.md)与本技能的[采集会话与输出约定](references/capture-session-schema.md)。

## 1. 前置草稿检查

- 确认已有包含完整按键图形、`data-ak-key`、`data-ak-region` 与稳定 `ak:input id` 的 SVG 草稿（通常位于 `docs/device-drafts/<device-id>.svg`）。还没有外观图稿时，先切换到 [axonkey-device-svg](../axonkey-device-svg/SKILL.md) 从照片生成草稿。
- 采集前先对草稿运行结构校验，确保输入 ID 与热区路径一一对应：
  ```sh
  python -X utf8 .agents/skills/axonkey-device-svg/scripts/validate_draft.py docs/device-drafts/<device-id>.svg
  ```
- 保留草稿既有的稳定设备 ID 与按键 ID，不在采集阶段随意重命名。

## 2. 枚举候选设备与安全分级

运行以下命令获取本机候选输入设备及蓝牙 GATT 设备信息（`0x180A` 的厂商 `0x2A29`、型号 `0x2A24`、固件版本 `0x2A28`）：

```sh
axonkey-cli capture list --with-gatt --json
```

向用户展示匹配的候选设备（`displayName`、`transport`、`instanceId`、`vid`/`pid`、`gattInfo`、`boundToQuarbor`、`safetyTier`），由用户明确确认目标 `instanceId` 后再操作驱动或开始采集。严禁遵守以下安全边界：

- `safe`（蓝牙低功耗遥控器、Consumer `0x0C`、厂商自定义页 `0xFF00..`、手柄等）：用户确认目标后可直接挂载采集。
- `caution`（本机存在至少两把物理键盘时的外接副键盘）：必须提醒用户挂载 Quarbor 后该副键盘原按键在未透传时会被拦截，经确认后才传入 `--allow-caution`。
- `blocked`（指针/鼠标设备，或当前机器唯一的物理键盘）：默认严禁挂载拦截驱动，防止锁死主输入。除非用户明确备有触控/远程/另一套可用输入并主动要求覆盖，绝不传入 `--allow-primary-input`。
- 虚拟输出节点（`ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT`、`QUARBOR\*`）、ACPI/PS2 内置节点和触控板已在底层硬排除，不作为采集对象。

## 3. Windows 驱动挂载与恢复纪律

- **需要挂载 Quarbor 的场景**：Windows 会独占打开标准键盘（`0x01/0x06`）与蓝牙 HOGP 集合，`hidapi` 无法直接读取按键报告。若目标候选 `boundToQuarbor: false`，先告知用户系统将弹出一次 UAC 管理员授权窗口，再执行：
  ```sh
  axonkey-cli capture attach --instance-id "<INSTANCE_ID>" --json
  ```
  - 用户在 UAC 弹窗点击取消时，返回 `cancelledByUser: true`（退出码 `1223`），礼貌停止或等待用户重试，不反复刷弹窗。
  - 返回 `rebootRequired: true` 时如实提示重启后再继续采集。
- **卸载与恢复承诺**：采集目标若是尚未正式内置注册的新设备，在完成采样或中途放弃退出前，询问或按约定恢复系统原生驱动，避免新设备留在拦截静默态：
  ```sh
  axonkey-cli capture detach --instance-id "<INSTANCE_ID>" --json
  ```
  即便设备已断开休眠，只要 `boundToQuarbor` 或 `recoveryActive` 为真，`capture list` 仍会保留该节点供一键 `detach` 恢复。

## 4. 逐键引导采集与冲突复核

优先使用可断点续采的向导命令把样本增量写入会话文件（如 `docs/device-drafts/<device-id>.capture.json`）：

```sh
axonkey-cli capture wizard \
  --instance-id "<INSTANCE_ID>" \
  --draft docs/device-drafts/<device-id>.svg \
  --session-file docs/device-drafts/<device-id>.capture.json
```

也可在脚本或 AI 逐键对话中每次只采一个指定按键（推荐配合 `--json`）：

```sh
axonkey-cli capture key \
  --instance-id "<INSTANCE_ID>" \
  --input-id "<INPUT_ID>" \
  --timeout-ms 12000 \
  --json
```

采样与异常处理要点：

- **提示节奏**：采集前提醒用户先保持设备静止约 0.5 秒以建立空闲基线，再“短按一次目标键并松开”。
- **高频流噪声自动隔离**：陀螺仪飞鼠（如 `0x6F`）或语音 PCM 流（如 `0xEC`）在未按键时持续高频变化的 Report ID 会被自动归入 `streamingReportIds` 过滤，不会阻塞普通按键采样；在交接记录中保留观察到的流式 Report ID 供后续专项协议分析。
- **红外/纯硬件键跳过**：电源键或电视音量键若只发红外信号、不产生蓝牙/USB HID 报文，采样超时属于正常硬件行为；跳过该键使其在产物中保持 `binding="pending"` 并在 `.md` 记录注明，不要伪造键值。
- **双键同码复测**：若两个不同物理按键采到相同的 `(reportId, pressHex)`，编译器会输出 `collisions` 警告；用 `capture key --input-id <ID>` 单独重采这两个键确认是按错键还是硬件本身同码复用。

## 5. 编译 `axonkey.device/1` 描述符与校验

采集完成后，将草稿 SVG 与会话样本合并编译，同时生成交接摘要 Markdown：

```sh
axonkey-cli capture compile \
  --draft docs/device-drafts/<device-id>.svg \
  --session docs/device-drafts/<device-id>.capture.json \
  --out docs/device-drafts/<device-id>.captured.svg \
  --markdown-out docs/device-drafts/<device-id>.captured.md \
  --status active \
  --json
```

核对返回的 JSON 结果：

- `validated` 必须为 `true`（内部已通过 `axonkey_lib::device_descriptor::parse_svg` 正式引擎解析校验，确保 `<ak:identity>`、每个 `(reportId, length)` 唯一匹配的 `<ak:report>` 以及非重叠位宽 `<ak:source>` 合法）。
- 检查 `adaptedCount`、`pendingCount` 与 `collisions`。已采按键带 `<ak:hid-capture version="1" .../>` 审计记录与 `binding="captured"`；未采按键保持 `binding="pending"`。
- 若目标仍作为草稿留在 `docs/device-drafts/`（`--status draft`），仅存在待采键而尚未写入 `<ak:identity>` 时可再用 `validate_draft.py` 校验结构；已含 `<ak:identity>` 与 `<ak:reports>` 的完整 v1 描述符直接以 `capture compile` 的 `validated: true` 和 Rust `devices` 单元测试为准（`validate_draft.py` 仅针对纯无协议草稿）。

## 6. 正式内置接入（可选）

若本次任务范围包含把新设备正式接入 Axonkey 内置支持列表（而不仅是交付已采集 SVG 与交接记录），按 [docs/DEVICE_INTEGRATION.md](../../../docs/DEVICE_INTEGRATION.md) 完成后续注册与回归：

1. 将验证通过的 SVG 移入 `public/device-descriptors/<name>.svg`（使用 `--status active`）。
2. 在 `src-tauri/src/devices/descriptor_registry.rs` 注册 `KINDS` 与 `descriptor_for_kind`，补充真实样本解码回归测试并运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib devices`。
3. 运行 `npm run generate:devices` 更新 `src/devices/generatedDescriptors.ts`（切勿手改生成文件），并在 `src/devices/` 补充薄支持包定义与 `supportPackages` 登记。
