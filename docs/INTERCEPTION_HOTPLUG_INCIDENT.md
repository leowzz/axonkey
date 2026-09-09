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
