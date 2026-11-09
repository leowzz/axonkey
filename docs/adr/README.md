# 架构决策记录（ADR）

按 [AGENTS.md 的适用范围](../../AGENTS.md#issue-与-pr) 判断是否进入 ADR 流程。进入后，只记录难以逆转且有实质取舍的架构决定，例如设备与平台的职责边界、持久化结构或兼容承诺。当前结构见[架构说明](../ARCHITECTURE.md)，任务进度留在 Issue。

- 在 `docs/adr/` 按现有最大编号加一，命名为 `NNNN-short-title.md`。
- 写清背景、决定、主要取舍及影响。适用时链接相关 Issue、PR 或现有设计。状态使用 `proposed`、`accepted` 或 `superseded`。
- 决定被替代时新增 ADR，旧记录标记 `superseded`，两份记录互相链接。保留原编号和历史理由。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-windows-rc003-input-by-device-instance.md) | Windows RC003 输入按设备实例绑定 | `accepted` |
