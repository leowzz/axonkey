# Windows 虚拟音频端点识别

状态：基于 v0.3.18 接入端点绑定与旧版首次升级自动识别，保留主线的手动音频重启功能。

## 故障原因

旧实现通过 CPAL `description.name()` 的 `cable input` 前缀选择播放设备。改名、本地化或驱动改变显示名称后，设备仍存在，但软件无法找到它，并误报 `driverMissing`。

本次故障的播放端显示为“扬声器 (2- VB-Audio Virtual Cable)”。按键映射正常，语音没有输入；恢复名称后，旧实现重新连接并收到语音。v0.2.8 与 v0.3.15 使用相同名称筛选条件，这些证据不能证明升级造成了改名。

## 设备身份与选择

`windows_endpoints.rs` 使用 MMDevice API 枚举播放、录音端及 active、disabled、unplugged、notPresent 状态。通过 DeviceTopology 关联父适配器；拓扑查询失败时尝试文档化的 PnP Parent 属性，再用 Configuration Manager 读取适配器身份。不依赖 MMDevices 注册表布局。

当前只支持已核验的标准 VB-CABLE 组合：Hardware IDs 包含 `VBAudioVACWDM`，且 Service 为 `VBAudioVACMME`，匹配不区分大小写。端点自身的通用 Hardware ID `MMDEVAPI\AudioEndpoints`、FriendlyName、CPAL 的适配器显示名均不能代替这组身份。

选择规则由 `endpoint_selection.rs` 实现：

- 保存原始 `IMMDevice::GetId()` 字符串，与 CPAL WASAPI `device.id()?.id()` 精确匹配；不解析或归一化端点 ID，不保存带 `wasapi:` 前缀的 CPAL 显示字符串。
- 已有绑定时验证方向、适配器实例和受支持身份。改名只更新显示；绑定失效时保留选择并提示恢复或重新选择，不改用其他端点或系统扬声器。
- 无绑定且配置正常时自动迁移。首次选择忽略 `notPresent` 的历史端点；它们仍保留在列表中，也仍参与已有绑定的校验。只有一个当前受支持播放端时自动选择，禁用或断开时报告对应状态。
- 同一受支持适配器有多个播放端时，读取文档化的 `PKEY_AudioEndpoint_FormFactor`：标准 VB-CABLE 的普通端口为 `Speakers`，额外的 16 声道端口为 `LineLevel`。只有普通端口唯一、其余端口均为已知线路类型时自动选择普通端口；首次升级前已改名也适用。禁用、断开的普通端口仍保留其优先级；同一适配器已知普通端口为 `notPresent` 而只剩线路端时也不会自动改选 16 声道端口。
- 多个当前适配器、重复普通端口、端口类型缺失或未知时仍要求明确选择。不取枚举第一项，不靠名称、`16ch` 后缀或声道数猜测端口。普通扬声器即使命名为 CABLE Input，也不会成为候选。
- 同适配器只有一个可用录音端时自动关联；否则保持未关联，允许明确选择。关联只说明属于同一适配器，不能证明内部回环路由正确。

设置 → 设备与权限提供播放端与录音端选择、重新检测和清除绑定。首页与音频测试显示实际名称和针对性提示；未关联录音端时引导用户选择，不固定假定麦克风名称为 CABLE Output。

旧版本没有保存设备 ID，因此首次迁移只能恢复可确定的标准 VB-CABLE 路由，不能重建多个适配器之间未记录的历史选择。迁移成功后保存本机 ID，后续改名或重启沿用绑定。已保存的手动选择（包括 16 声道端口）优先；损坏配置不会触发迁移覆盖。迁移不改变 Windows 或第三方录音软件的默认输入、输出设备。

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

已增加纯策略、配置和界面行为测试，覆盖改名、同名、枚举顺序、多实例、禁用、方向或适配器不匹配、名称伪装、ID 失效、配置损坏、原子替换失败保护，以及结构化状态和选择流程。首次升级用例另覆盖普通与 16 声道端口共存、两个端口共享格式相同或被修改、历史驱动残留、元数据缺失、手动绑定优先。具体执行结果由本次 PR 记录。

Windows 真机已通过两个显式集成测试：原生枚举发现当前实例的两个播放端和一个录音端，并保留历史实例的不可用端点；输出线程在真实 WASAPI 启动后保存绑定，锁住配置文件造成替换失败时恢复旧播放流并保留旧配置，清除后进入等待选择。桌面 UI 已验证首次消歧、实际名称和关联录音端、保存到本机配置、重启恢复、GATT 连接，以及 1180×820 和 980×680 窗口下的设备设置。

2026-09-25 在 v0.3.18 基础上验证：101 项 Rust 单元测试、22 项相关前端行为测试通过；显式运行 3 项真机测试全部通过，其中新增无配置首次迁移及重启恢复测试。本机普通端口已改名为“扬声器”，普通与 16 声道端口均启用且共享格式均为 2 声道，并存在 3 个历史不可用端点。原生枚举读到播放端类型分别为 1（Speakers）与 2（LineLevel），迁移无需手动选择即可成功。实际用户绑定文件测试前后 SHA-256 一致。

2026-09-23 的前版修复已完成真实讲话验证：普通播放端改名为“扬声器”并重启后，独立 WASAPI 录音端电平探针在 CABLE Output 上检测到持续非零信号，松开后归零。探针未保存录音，未评估回放音质。本次首次迁移另用隔离配置验证无绑定启动、自动关联录音端、保存及重启恢复；不改动实际用户配置，不启动测试 BLE 连接。

macOS 原生运行、多活动适配器真机及驱动重装仍需对应环境验证；收到 BLE 数据或应用内估算电平不等于录音应用已收到声音。

本次未实现 `IMMNotificationClient` 设备通知、`PKEY_AudioEndpoint_StableId` 恢复或更多虚拟声卡家族。普通端点 ID 不是永久硬件序列号；驱动重装或系统变化使 ID 失效时，需要重新选择。StableId 仅是后续可选增强，不是本次兼容性前提。

## 参考

- [CPAL 0.18.2 DeviceTrait](https://docs.rs/cpal/0.18.2/cpal/traits/trait.DeviceTrait.html)：端点 ID 与描述。
- [CPAL 0.18.2 HostTrait](https://docs.rs/cpal/0.18.2/cpal/traits/trait.HostTrait.html)：设备枚举与按 ID 查找。
- [IMMDevice::GetId](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdevice-getid)：不透明端点 ID。
- [IConnector::GetDeviceIdConnectedTo](https://learn.microsoft.com/en-us/windows/win32/api/devicetopology/nf-devicetopology-iconnector-getdeviceidconnectedto)：端点拓扑关联。
- [PKEY_AudioEndpoint_FormFactor](https://learn.microsoft.com/en-us/windows/win32/coreaudio/pkey-audioendpoint-formfactor)：Windows 提供的端口类型，独立于可改名的显示标签和共享音频格式。
- [IMMNotificationClient](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nn-mmdeviceapi-immnotificationclient)：后续设备与属性变化通知。
- [PKEY_AudioEndpoint_StableId](https://learn.microsoft.com/en-us/windows/win32/coreaudio/pkey-audioendpoint-stableid)：后续可选稳定端点 ID。
