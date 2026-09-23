# Windows 虚拟音频端点识别

状态：基础修复已实现，基于 v0.3.15，已完成 Windows 设备发现、播放流及配置失败恢复验证。

## 故障原因

旧实现通过 CPAL `description.name()` 的 `cable input` 前缀选择播放设备。改名、本地化或驱动改变显示名称后，设备仍存在，但软件无法找到它，并误报 `driverMissing`。

本次故障的播放端显示为“扬声器 (2- VB-Audio Virtual Cable)”。按键映射正常，语音没有输入；恢复名称后，旧实现重新连接并收到语音。v0.2.8 与 v0.3.15 使用相同名称筛选条件，这些证据不能证明升级造成了改名。

## 设备身份与选择

`windows_endpoints.rs` 使用 MMDevice API 枚举播放、录音端及 active、disabled、unplugged、notPresent 状态。通过 DeviceTopology 关联父适配器；拓扑查询失败时尝试文档化的 PnP Parent 属性，再用 Configuration Manager 读取适配器身份。不依赖 MMDevices 注册表布局。

当前只支持已核验的标准 VB-CABLE 组合：Hardware IDs 包含 `VBAudioVACWDM`，且 Service 为 `VBAudioVACMME`，匹配不区分大小写。端点自身的通用 Hardware ID `MMDEVAPI\AudioEndpoints`、FriendlyName、CPAL 的适配器显示名均不能代替这组身份。

选择规则由 `endpoint_selection.rs` 实现：

- 保存原始 `IMMDevice::GetId()` 字符串，与 CPAL WASAPI `device.id()?.id()` 精确匹配；不解析或归一化端点 ID，不保存带 `wasapi:` 前缀的 CPAL 显示字符串。
- 已有绑定时验证方向、适配器实例和受支持身份。改名只更新显示；绑定失效时保留选择并提示恢复或重新选择，不改用其他端点或系统扬声器。
- 无绑定且配置正常时，仅有一个受支持播放端才自动选择，打开并保存成功后生效。禁用、断开的端点也计入候选数量；唯一端点不可用时报告对应状态。
- 多个播放端必须明确选择，不取枚举第一项，也不靠名称、`16ch` 后缀或声道数猜测端口。普通扬声器即使命名为 CABLE Input，也不会成为候选。
- 同适配器只有一个可用录音端时自动关联；否则保持未关联，允许明确选择。关联只说明属于同一适配器，不能证明内部回环路由正确。

设置 → 设备与权限提供播放端与录音端选择、重新检测和清除绑定。首页与音频测试显示实际名称和针对性提示；未关联录音端时引导用户选择，不固定假定麦克风名称为 CABLE Output。

## 保存、切换与恢复

Rust 在应用配置目录保存 `windows-audio-output.json`，仅含以下四项，不混入按键映射导入导出或音量设置：

```json
{
  "schemaVersion": 1,
  "renderEndpointId": "原始播放端 MMDevice ID",
  "captureEndpointId": null,
  "adapterInstanceId": "父适配器 PnP 实例 ID"
}
```

`endpoint_config.rs` 校验格式、版本及必要身份字段。配置损坏时只报告错误，音频线程阻止自动覆盖；用户明确选择可以修复配置，也可以清除后重新选择。保存采用同目录唯一临时文件，写入、flush、sync 后通过 Windows `MoveFileExW` 替换；失败保留旧文件并清理自身临时文件。

`windows.rs` 的音频工作线程串行处理选择和清除请求。切换先验证端点及默认共享格式，然后停止旧流、清理待发 PCM、打开新流。WASAPI 的 `play()` 只提交异步启动请求，因此等待首个真实输出回调（最多 5 秒）确认启动后才保存绑定。打开或保存失败时保留原持久化绑定并尝试恢复旧流；恢复失败则报告无可用输出。切换不承诺无缝连续。清除只删除绑定，本次运行进入等待选择状态，不清除按键映射或音量。

设备发现、文件访问和切换不在实时音频回调中执行。当前使用轮询：无活动输出时约每 2 秒重试，已有活动输出时约每 5 秒更新元数据；手动重新检测可提前触发查询。健康输出仅发生改名时更新标签，不重建播放流；暂时枚举失败也不会中断健康流。

## 状态接口

Windows 前端使用 `AudioServiceStatus.output` 的结构化状态，与蓝牙连接、收到数据和正在转发分别展示。兼容字段 `driverInstalled` 表示发现受支持端点，不证明驱动包安装状态，也不再由播放流打开失败直接推导“未安装”。

| 输出状态 | 含义 |
| --- | --- |
| `adapterMissing` | 当前未发现受支持的虚拟音频设备 |
| `selectionRequired` | 多个候选或需要用户重新选择 |
| `endpointDisabled` | 选中的播放端被禁用 |
| `endpointUnavailable` | 端点断开、ID 失效或关联不匹配 |
| `enumerationFailed` | 无法完成设备身份枚举 |
| `unsupportedFormat` | 音频格式不可用或不受支持 |
| `openFailed` | 播放流无法打开或运行失败 |
| `configError` | 配置读取、校验或保存失败 |
| `switching` | 正在初始化或切换输出 |
| `ready` | 选中的播放流已打开 |

IPC 命令为 `get_windows_audio_endpoints`、`set_windows_audio_endpoint`、`clear_windows_audio_endpoint`。列表返回端点元数据、当前绑定、输出状态和枚举错误；选择命令仅接受端点 ID，后端重新枚举并验证身份。

## 验证与未实现范围

已增加纯策略、配置和界面行为测试，覆盖改名、同名、枚举顺序、多实例、禁用、方向或适配器不匹配、名称伪装、ID 失效、配置损坏、原子替换失败保护，以及结构化状态和选择流程。具体执行结果由本次 PR 记录。

Windows 真机已通过两个显式集成测试：原生枚举发现当前实例的两个播放端和一个录音端，并保留历史实例的不可用端点；输出线程在真实 WASAPI 启动后保存绑定，锁住配置文件造成替换失败时恢复旧播放流并保留旧配置，清除后进入等待选择。桌面 UI 已验证首次消歧、实际名称和关联录音端、保存到本机配置、重启恢复、GATT 连接，以及 1180×820 和 980×680 窗口下的设备设置。

自动测试包括 93 项 Rust 测试及 18 项相关前端行为测试，前端和 Windows 程序构建通过。macOS 原生运行、多活动适配器、驱动重装和真实语音录音回放仍需对应环境验证；收到 BLE 数据或应用内估算电平不等于录音应用已收到声音。

本次未实现 `IMMNotificationClient` 设备通知、`PKEY_AudioEndpoint_StableId` 恢复或更多虚拟声卡家族。普通端点 ID 不是永久硬件序列号；驱动重装或系统变化使 ID 失效时，需要重新选择。StableId 仅是后续可选增强，不是本次兼容性前提。

## 参考

- [CPAL 0.18.2 DeviceTrait](https://docs.rs/cpal/0.18.2/cpal/traits/trait.DeviceTrait.html)：端点 ID 与描述。
- [CPAL 0.18.2 HostTrait](https://docs.rs/cpal/0.18.2/cpal/traits/trait.HostTrait.html)：设备枚举与按 ID 查找。
- [IMMDevice::GetId](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdevice-getid)：不透明端点 ID。
- [IConnector::GetDeviceIdConnectedTo](https://learn.microsoft.com/en-us/windows/win32/api/devicetopology/nf-devicetopology-iconnector-getdeviceidconnectedto)：端点拓扑关联。
- [IMMNotificationClient](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nn-mmdeviceapi-immnotificationclient)：后续设备与属性变化通知。
- [PKEY_AudioEndpoint_StableId](https://learn.microsoft.com/en-us/windows/win32/coreaudio/pkey-audioendpoint-stableid)：后续可选稳定端点 ID。
