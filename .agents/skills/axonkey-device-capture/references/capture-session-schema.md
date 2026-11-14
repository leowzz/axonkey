# 采集会话与输出约定

本文档定义 `axonkey-cli capture` 与桌面端设备采集工作台共享的会话文件格式（`axonkey.capture-session/v1`）、`<ak:hid-capture>` 元数据及常用 `--json` 返回结构。

## 1. 会话文件格式（`axonkey.capture-session/v1`）

`axonkey-cli capture wizard --session-file <PATH>` 会在每采完一个按键后原子写回该 JSON 文件；`axonkey-cli capture compile --session <PATH>` 直接读取该文件（也兼容纯 `CapturedKeySample[]` 数组）。

```json
{
  "schema": "axonkey.capture-session/v1",
  "candidate": {
    "targetId": "bluetooth-le:8f4d2c9a10e3b712",
    "displayName": "TCL RC802A",
    "transport": "bluetooth-le",
    "instanceId": "BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&010416_PID&0301_REV&0001_AA11BB22CC33\\8&12345678&0&0015",
    "vid": 1046,
    "pid": 769,
    "usagePage": 12,
    "usage": 1,
    "boundToQuarbor": true,
    "recoveryActive": true,
    "registeredKind": null,
    "safetyTier": "safe",
    "safetyReason": null,
    "gattInfo": {
      "manufacturer": "TCL",
      "modelNumber": "BT_RC802A",
      "softwareRevision": "V1.0.2",
      "bluetoothAddress": "AA11BB22CC33"
    }
  },
  "samples": [
    {
      "inputId": "tcl.rc802a.home",
      "reportId": 2,
      "pressHex": "02 23 02",
      "releaseHex": "02 00 00",
      "pressLength": 3,
      "releaseLength": 3,
      "holdCount": 1,
      "durationMs": 118
    },
    {
      "inputId": "tcl.rc802a.up",
      "reportId": 1,
      "pressHex": "01 00 00 52 00 00 00 00 00",
      "releaseHex": "01 00 00 00 00 00 00 00 00",
      "pressLength": 9,
      "releaseLength": 9,
      "holdCount": 0,
      "durationMs": 94
    }
  ]
}
```

字段说明：

- `pressHex` / `releaseHex`：首字节始终为 `reportId`，以大写空格分隔十六进制字节表示，与正式描述符 `<ak:hid-capture>` 一致。
- `pressLength` / `releaseLength`：包含首字节 `reportId` 在内的总字节长度，对应 `<ak:report id="..." length="...">`。
- 若设备的某个按键仅发送按下单帧而不发回零松开帧，采样器在静止超时后记录脉冲帧，`releaseHex` 为空字符串、`releaseLength` 为 `0`。

## 2. 编译写入的 SVG 元数据

`capture compile` 严格保留草稿中 `<metadata>` 之外的全部视觉图形与 `data-ak-regions` 热区，仅更新根 `<svg>` 状态属性并合成 `<ak:device>` 下的协议节点：

- `<ak:identity>`：根据候选设备的 `transport`、`instanceId`（保留蓝牙 BLE 24-bit `DEV_VID&010416` 原始十六进制值以兼容双端匹配）、`vid`/`pid` 与 `gattInfo` 生成 `<ak:match>`；若未提供候选设备但草稿内有 `<ak:pending-identity>`，自动提升其 `vid`/`pid` 与 GATT `manufacturer-contains` / `model-contains` 条件。
- `<ak:reports>`：按 `(reportId, pressLength)` 分组，每组生成唯一一条 `encoding="bit-field"` 的 `<ak:report>`，确保 `DescriptorEngine` 按 `(report_id, length)` 匹配时不产生多报告歧义。
- `<ak:inputs>`：
  - 已采样按键写入 `binding="captured"`、`<ak:source report="..." offset="..." width="..." endian="little" equals="..." />` 与 `<ak:hid-capture version="1" report-id="0x.." press="..." release="..." />`。当同一 `(reportId, length)` 下不同按键的变化字节跨越多字节（如 `02 E9 00` 与 `02 23 02`），编译器自动选取覆盖变化区间的连续位段（最大 64 位），避免单字节截断误触发。
  - 未采样按键保留 `binding="pending"` 且不伪造 `<ak:source>`。

## 3. CLI `--json` 信封结构

所有 `axonkey-cli capture ... --json` 子命令统一输出 `axonkey.cli/v1` 信封：

- 成功：退出码 `0`，标准输出 `{"protocolVersion":"axonkey.cli/v1","ok":true,"command":"capture.<subcommand>","result":...}`。
- 失败：退出码非 `0`（参数错误为 `2`，运行期/硬件/安全拦截错误为 `1`），标准输出 `{"protocolVersion":"axonkey.cli/v1","ok":false,"error":{"code":"...","message":"..."}}`。
