# TCL RC902V

图稿、27 个按键及原始 HID 采集位于 `public/device-descriptors/tcl-rc902v.svg`；来源为 `docs/device-drafts/tcl-rc902v.svg`。语音触发键为 `A`（`#key-assistant`，稳定 ID `tcl-rc902v.assistant`，HID 采集 `03 21 02` / `03 00 00`）。

## 录音与传输

- 采用 Google ATVV BLE GATT 通道（服务 `AB5E0001-5A21-4F05-BC7D-AF01F617B664`，写入 `AB5E0002`，音频通知 `AB5E0003`，控制通知 `AB5E0004`）。
- 固定为 **HTT（Hold-to-Talk，按住说话、松手结束）** 模式（`trigger-modes="hold"`）：按下 `A` 键后等待遥控器发送 `AUDIO_START(reason=0x03)`，松手由遥控器发送 `AUDIO_STOP(reason=0x02)`，主机不使用 HID 边沿主动关闭或切换录音模式。
- 连接并订阅 `AUDIO`、`CONTROL` 通知后，主机发送 `GET_CAPS = 0A 01 00 00 03 03`（声明 ATVV v1.0 的 On-request/PTT/HTT 能力集合），仅接受返回的 HTT (`model=0x03`) 能力和 `AUDIO_START(reason=0x03)`；`START_SEARCH (0x08)`、On-request/PTT 会话均不会触发录音。未知协议版本或非 HTT 能力立即停止且不盲写控制指令。
- Windows 与 macOS 复用 `xiaomi_remote::voice` 的实例级 BLE GATT 桥接、增益校准与虚拟麦克风输出（Windows `Quarbor Virtual Microphone`，macOS `MiRemoteV 2ch`），设备设置不提供录音模式切换；旧配置中的模式值也会被服务端固定收敛为 `hold`。按实例绑定的 12 位蓝牙地址筛选目标设备。

## ADPCM 解码与重采样

- ATVV v1.0 使用无预设表头的连续 IMA ADPCM 解码器（每字节高 4 位 nibble 在前、低 4 位 nibble 在后），每段新语音流在 `AUDIO_START` 时将 `predictor = 0`、`step_index = 0` 清零，不在流内按包重置，亦不剥离 v0.4e 6 字节头；ATVV v0.4e 在 `AtvvV04` 分支按帧读取 6 字节头中的 `(predictor, step_index)`。
- 支持 `AUDIO_SYNC (0x0A)`：按协商的 `bytes_per_frame` 校验已完成帧计数（缺帧仅记录缺口统计，不填充假帧），并在帧边界将解码器对齐到上报的 `(predictor, step_index)`。
- 虚拟麦克风管线固定使用 16 kHz 单声道 `i16` PCM；当协商编解码为 `0x01`（8 kHz ADPCM）时，在送入音频输出前线性插值上采样至 16 kHz。`WavSink` 供独立工具或回归测试落盘标准 RIFF/WAVE 文件。

## 验证边界

- 已确认事实：RC902V 暴露 `AB5E0001` ATVV 服务及 `A` 键 HID 报告 `03 21 02` / `03 00 00`。
- 自动测试全部使用合成 ATVV 控制报文与合成 IMA ADPCM 向量，覆盖 HTT 能力协商、非 HTT `AUDIO_START` 主动关闭、按住说话生命周期、跨流解码状态隔离、非流态丢包、`AUDIO_SYNC` 帧对齐与缺口计数、`MIC_EXTEND` 保活、超时恢复、WAV 封装及 Windows/macOS 实例路由。
- 尚未采集 RC902V FMR1 实机 `CAPS_RESP` 原始字节、`AB5E0003` 单包通知长度及真实人声录音；实机蓝牙抓包与语音听感仍待硬件联调确认。
- 已兼容 `045E:0040` BLE 硬件批次（如固件 `v1.5.8_20230825` 且软件/固件串不含 `RC902V`）的身份发现、绑定、驱动与 ATVV 服务筛选；该硬件批次的实际按键 HID 报告及实机语音仍待 Windows 实机联调确认。
