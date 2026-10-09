# Interception 重连问题说明

Axonkey 的 Windows 输入后端使用 Interception 1.0.1。该驱动存在断连后重新连接
可能无法输入的已知问题，本页记录其现象、原因和恢复方法。

## 现象

RC003 断开连接、休眠或重新配对后，Windows 可能重新创建它的 HID 键盘节点。
出现问题时，系统仍显示设备已连接、节点状态正常，但按键无法向应用发送输入。
退出或重新启动 Axonkey 不一定能恢复；即使没有运行使用 Interception 的应用，
也可能发生同类现象。上游原始报告见
[issue #25](https://github.com/oblitum/Interception/issues/25) 和
[issue #93](https://github.com/oblitum/Interception/issues/93)。

## 原因

问题位于 Interception 内核过滤驱动处理设备移除和重新枚举的环节。
上游 [issue #193](https://github.com/oblitum/Interception/issues/193) 汇总的解释是：
驱动只处理固定范围的设备编号，例如 `KbdClass0` 到 `KbdClass9`；
设备反复断开、连接后，Windows 分配的新编号可能超出这一范围。
因此，同一台设备多次重连也可能触发，不能理解为只有同时连接十多台键盘才会发生。
具体触发次数与系统设备枚举状态有关，不能假定每次重连或固定次数后必然失败。

上述编号机制来自上游 issue 的分析；本项目既有排查直接观察到的是：
RC003 的 Windows HID 节点存在，但没有可用的 Interception 设备槽位。
Axonkey 的 VID/PID 过滤、重新创建 context 或退出时清理过滤条件，
都只作用于用户态调用，无法修复已经异常的内核设备状态。

## 既有排查证据

2026-08-24 在 Windows 11 x64、Axonkey 0.1.4 / 0.1.5 上记录过以下状态：

- RC003 重连后的 HID 键盘节点存在，Windows 未报告设备错误。
- 设备栈包含 Interception 的 `keyboard` 上层过滤驱动：

  ```text
  \Driver\kbdclass
  \Driver\keyboard
  \Driver\kbdhid
  \Driver\mshidumdf
  ```

- 只读调用 `interception_get_hardware_id` 时，槽位 1–5 是其他键盘，6–10 为空，
  RC003 未出现在任何槽位中。
- 当时尝试的连接宽限期、PnP 检测、重建 context、等待 HID 节点稳定及退出时清理
  过滤条件，均未恢复该异常状态下的输入。

这些记录对应当时的故障环境，用于说明问题表现和定位依据。

## 恢复方法

遇到该现象时，重启电脑即可。

## 集成方案

本分支增加固定 v0.5.2 的 `interception-driver-fix` 源码集成，保持 `lockdown=no`。Windows 输入驱动安装流程会一并安装服务；已安装驱动的用户升级后会先看到可选增强提示，选择安装后才会请求授权。其补充系统对象链接的思路来自上游，不能据此认定本文历史问题已经修复。需要 Windows 实机测试并验证重启后的回滚，步骤见[重连兼容修复验证指南](./INTERCEPTION_FIX_TESTING.md)。

### 修复原理

`interception-driver-fix` 在 Windows 内核对象命名空间中创建类设备名称的符号链接。
当前集成的具体实现见 [`src/core.hpp`](../third_party/interception-driver-fix/src/core.hpp)，
默认配置见 [`scripts/interception-fix.ps1`](../scripts/interception-fix.ps1)。
`keyboard-symlinks=1000` 和 `pointer-symlinks=1000` 对应以下链接：

```text
\Device\KeyboardClass10  → \Device\KeyboardClass0
\Device\KeyboardClass11  → \Device\KeyboardClass1
...
\Device\KeyboardClass19  → \Device\KeyboardClass9
\Device\KeyboardClass20  → \Device\KeyboardClass0
...
\Device\KeyboardClass999 → \Device\KeyboardClass9
```

鼠标的 `PointerClass` 使用相同算法。对于编号 `10–999`，链接目标编号为 `n % 10`。
这创建的是系统对象的别名，不是磁盘上的快捷方式，也不增加 Interception 的独立设备槽位。
若同名对象已经存在，代码会保留它，不覆盖或替换已有设备对象。

结合上游关于编号范围的分析，这个方案的预期作用是：让高编号类设备名称仍能解析到
低编号类设备对象，从名称解析层绕过重连时的编号问题。符号链接的方向和范围可以直接
从源码确认；Interception 内部如何在故障路径上使用这些名称，以及它是否覆盖本项目
历史故障，仍需通过 Windows 实机观察确认，不能仅凭这些链接就认定驱动问题已彻底解决。

这也解释了它与重启 Axonkey 的区别：重新创建用户态 context 只重开驱动接口；
这个方案改变的是系统对象命名空间，作用于应用之外。修复程序运行在用户态，
通过 Windows Native API `NtCreateSymbolicLinkObject` 创建链接，不修改或替换
Interception 的 `keyboard.sys`、`mouse.sys` 文件。

### 为什么需要开机服务和重启

创建带 `OBJ_PERMANENT` 标记的系统对象链接需要特殊权限。Axonkey 为服务配置
`SeCreatePermanentPrivilege`，由 LocalSystem 在每次开机时运行一次，创建链接后立即退出。
关闭创建句柄后，链接仍保留在本次 Windows 启动期间，因此服务无需持续监听设备，
执行完成后显示“已停止”是正常状态。

安装脚本只注册自动启动服务，不立即运行修复，所以安装后需要重启 Windows。
卸载服务也不会删除本次启动内已有的链接，需要重启完成回滚。
`lockdown=no` 与重连修复是不同功能：它让普通权限 Axonkey 保持对 Interception 的访问；
本地集成已移除设备 ACL 写入代码，不依靠修改设备访问权限修复重连。

### 已有反馈与验证范围

[上游 RC003 用户反馈](https://github.com/hygorostrowskij/interception-driver-fix/issues/1)
报告了安装后按键恢复、睡眠唤醒后可重连的结果。这提供了个案依据，
当前 Axonkey 集成仍未完成完整 Windows 实机验收。
该方案影响系统级键盘和鼠标类设备名称，验收时需同时检查 RC003、普通键盘和鼠标，
并验证卸载重启后的状态；具体步骤见[验证指南](./INTERCEPTION_FIX_TESTING.md#验收清单)。
