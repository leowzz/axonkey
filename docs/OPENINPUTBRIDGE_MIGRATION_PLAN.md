# Axonkey Windows OpenInputBridge 迁移方案

- 方案日期：2026-08-24
- 目标设备：小米 RC003，`VID_2717&PID_32B8`
- 目标系统：Windows 11 x64；Windows 10 22H2 作为兼容性验证项
- 当前状态：代码迁移已完成，等待授权 WHQL 包和 Windows 真机验收
- 详细选型依据：[Windows 单设备键盘输入替代方案调研](./WINDOWS_INPUT_ALTERNATIVES.md)
- Windows 接手步骤：[OpenInputBridge Windows 交割文档](./OPENINPUTBRIDGE_WINDOWS_HANDOFF.md)

## 1. 目标

以 OpenInputBridge 替换 Windows 上的 Interception，同时保持 Axonkey 的产品语义：

1. 只识别和过滤 RC003，普通键盘始终透传；
2. 支持 RC003 蓝牙休眠、断开、重连和槽位变化；
3. Axonkey 禁用、退出、崩溃或上下文销毁后，驱动过滤能够释放；
4. 不接受旧 Interception 伪装成兼容后端；
5. Secure Boot 和 Memory Integrity 保持开启；
6. 安装、升级、卸载和回滚均有明确恢复路径。

本方案不声称单靠代码审查已经解决真机断联。最终结论必须来自 Windows + RC003 的循环重连和失败透传验收。

## 2. 方案结论

采用 OpenInputBridge 1.00 WHQL 完成第一阶段迁移。Axonkey 不再加载 `interception.dll`，而是直接打开 OpenInputBridge 控制设备并调用 IOCTL。

选择该路线的原因：

- OpenInputBridge 使用 KMDF 的每设备 PnP 生命周期，设备移除时释放槽位；
- 过滤状态绑定控制句柄，句柄关闭时驱动清理过滤和队列；
- 它保留原协议的硬件 ID、过滤、读取和写回能力，现有映射/手势引擎无需重写；
- OIB 专有 identity 和动态槽位 IOCTL 可以明确拒绝旧驱动并适应重连后的槽位变化。

保留战略后备方案：若真机稳定性、失败透传、安全边界或 OEM 再分发许可任一项不通过，停止在兼容层继续投入，转向只绑定 RC003 键盘 TLC、带 heartbeat fail-open 的专用 KMDF device filter。

## 3. 目标架构

```text
RC003 keyboard HID
  -> OpenInputBridge keyboard class filter
       未过滤设备：立即透传
       RC003 临时槽位：送入 Axonkey 队列
  -> Axonkey Windows input worker
       检查 OIB 服务和 OIB1 identity
       获取动态 keyboard slot count
       每次创建 context 都重新读取 hardware ID
       只对 VID_2717&PID_32B8 设置 FILTER_KEY_ALL
       执行 click/double-click/long-press/repeat 映射
       将结果写回 RC003 槽位
  -> Windows keyboard stack
```

关键边界：

- 控制路径仍叫 `\\.\interceptionNN`，不能用路径名判断驱动类型；必须校验 OIB identity；
- 槽位号是一次连接内的临时标识，不能持久化；
- context 销毁时先关闭 control-device handle，再关闭 event handle；
- 等待或读取发生内核 I/O 错误时销毁整个 context，重新枚举，不把错误当成普通超时；
- 驱动存在不等于后端可用，UI readiness 还必须通过 context/identity 探测。

## 4. 已完成实现

### 4.1 Windows 输入后端

`src-tauri/src/input_service/windows.rs` 已完成：

- 移除 `libloading` 和 `interception.dll` 运行时加载；
- 增加直接 Kernel32/OIB IOCTL 客户端；
- 校验 `OIB1` signature、keyboard 标志和主版本；
- 读取 1..20 的动态键盘槽位数；
- 为每个槽位建立独占 handle 和事件；
- 每次 context 重建都重新按 hardware ID 选择 RC003；
- 目标消失、映射禁用、等待/读取失败或应用退出时销毁 context；
- 保留现有映射、组合键、单双击、长按和 repeat 逻辑；
- 增加 identity、协议布局、槽位变化和 slot-count 单元测试。

### 4.2 安装与打包

已完成：

- 新增 `scripts/openinputbridge-driver.ps1`；
- 新增 `scripts/openinputbridge-package.mjs`，Windows release 在 OIB 包不完整时失败；
- Tauri Windows resources 改为 OIB 目录和新驱动脚本；
- 安装前拒绝仍存在 `keyboard.sys`/`mouse.sys` 的旧 Interception；
- 对 installer 和两个 catalog 执行 Authenticode 校验；
- 安装时启用 OIB audit log/toast 并执行 vendor verify；
- 卸载时关闭 toast/audit 后调用 vendor uninstaller；
- Windows readiness 改查 `OpenInputBridgeKeyboard` 和 `OpenInputBridgeMouse` 服务；
- 新发布包不再捆绑或加载旧 Interception runtime。

### 4.3 UI 与文档

设置向导、状态消息、README、架构说明、产品范围和第三方声明已切换到 OpenInputBridge。旧 Interception 的故障只保留为历史事故和迁移依据。

## 5. 外部前置条件

在 Windows release 或真机验证前必须取得：

1. OpenInputBridge 1.00 或更新版的完整 WHQL package；
2. 允许随 Axonkey 安装包再分发的书面 OEM/redistribution 授权；
3. 支持的 Windows 版本、HVCI/Memory Integrity、更新和订阅终止条款；
4. installer、INF、CAT、SYS 的版本、SHA-256 和签名主体；
5. 对安装器实际签名主体是否为 `Applet LLC` 的确认。

批准后的文件布局：

```text
vendor/openinputbridge/
  OpenInputBridgeSetup.exe
  oib_kbd/
    oib_kbd.inf
    oib_kbd.cat
    oib_kbd.sys
  oib_mou/
    oib_mou.inf
    oib_mou.cat
    oib_mou.sys
```

不得把 test-signed 自编译包用于生产，也不得通过关闭 Secure Boot 或安装自签根证书绕过发布签名。

## 6. 安装与迁移策略

### 干净系统

1. Axonkey 调用 OIB 安装脚本；
2. 脚本验证完整性和签名，请求管理员权限；
3. 安装 keyboard/mouse 两部分并开启 audit/toast；
4. 重启 Windows；
5. Axonkey 通过服务、identity 和 context 探测后才显示后端可用。

### 已安装 Interception

必须分成两个重启阶段，不能自动混装：

1. 用旧 Interception 官方安装器执行 `/uninstall`；
2. 重启并确认 `keyboard.sys`/`mouse.sys` 消失；
3. 安装 OpenInputBridge；
4. 再次重启；
5. 运行 Axonkey 验收。

## 7. 验证计划

### 7.1 代码与包验证

- Rust Windows backend 单元测试；
- Rust 全量测试、格式和 Windows 原生编译；
- TypeScript/Vite build；
- release/package contract 测试；
- PowerShell AST parse；
- OIB 实际包 Authenticode、哈希和 installer verify；
- NSIS 安装包资源审计，确认不含旧 Interception binary。

### 7.2 RC003 真机验收

| 类别 | 最低通过条件 |
| --- | --- |
| 自动重连 | idle 断开/重建 100 次，每轮验证映射键真实到达 |
| 手工 PnP | reset 20 次、forget/pair 10 次、Bluetooth toggle 20 次 |
| 电源 | sleep/wake、hibernate/wake、Modern Standby 各 20 次（支持项） |
| 槽位扰动 | RC003 离线时插拔另一键盘，普通键盘零误捕获 |
| 失败透传 | disabled、正常退出、强杀、崩溃、进程冻结分别验证 |
| 并发输入 | 普通键盘持续输入时操作 RC003，零误吞、零误映射 |
| 映射语义 | original、disabled、单键、四键 chord、单双击、长按、repeat |
| 生命周期 | 安装、升级、失败中断、卸载、回滚后输入均可恢复 |
| 系统矩阵 | Win11 24H2/25H2；Win10 22H2 单列兼容结果；Secure Boot 开启 |

验收证据必须包含实际按键输出、Axonkey 日志、OIB audit/toast 和设备栈状态。“设备管理器正常”或“能重新创建 context”不能单独算通过。

## 8. Go/No-Go 标准

满足以下全部条件才允许发布：

- OEM 再分发授权明确；
- package 签名、哈希和来源归档完成；
- RC003 重连、槽位扰动和失败透传矩阵全部通过；
- 普通键盘零误捕获；
- uninstall + reboot 后恢复 Windows inbox input stack；
- Windows 目标版本与安全配置结果明确；
- NSIS 包不含旧 Interception runtime。

出现以下任一情况即 No-Go：

- RC003 再次出现必须重启才能恢复输入；
- Axonkey 退出/崩溃后过滤仍保持；
- 普通键盘被误捕获；
- OIB package 不能合法再分发；
- 需要关闭 Secure Boot/Memory Integrity 才能运行；
- vendor 安装/卸载不能可靠恢复系统输入栈。

## 9. 回滚

1. 关闭 Axonkey 和其他 OIB client；
2. 运行 `scripts/openinputbridge-driver.ps1 -Action Uninstall`；
3. 重启 Windows；
4. 检查 OIB 服务和 UpperFilters 已移除；
5. 用普通键盘与 RC003 验证 Windows inbox 输入路径；
6. 若卸载失败，停止继续安装其他过滤驱动，保留安装日志和 SetupAPI 日志做恢复分析。

回滚目标是恢复 Windows 原生输入，不是重新安装 Interception。
