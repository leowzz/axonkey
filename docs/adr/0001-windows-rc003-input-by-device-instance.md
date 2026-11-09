# Windows RC003 输入按设备实例绑定

状态 `accepted`

旧版 Interception 通过 Windows 键盘类过滤驱动采集输入，曾出现 RC003 断开后重连失效。Axonkey 将 RC003 的 Quarbor Universal 驱动绑定到用户选定的 `BTHLEDEVICE` 父设备实例，每个实例独立管理安装状态和输入管道。驱动范围因此限定到选定的遥控器，普通键盘继续走系统输入链路。

按实例绑定需要为每个 RC003 匹配设备节点和管理恢复记录。设备重新枚举后，客户端须重新解析实例并连接对应管道。卸载时按保存的原驱动信息恢复该实例。

[当前 Windows 输入链路](../WINDOWS_INPUT.md) · [旧版重连故障记录](../INTERCEPTION_HOTPLUG_INCIDENT.md)
