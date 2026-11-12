# TCL RC902V

图稿、27 个按键及原始 HID 采集位于 `public/device-descriptors/tcl-rc902v.svg`；来源为 `docs/device-drafts/tcl-rc902v.svg`。语音触发键为 `A`（`#key-assistant`，稳定 ID `tcl-rc902v.assistant`，HID 采集 `03 21 02` / `03 00 00`）。

## 录音与传输

- 采用 Google ATVV BLE GATT 通道（服务 `AB5E0001-5A21-4F05-BC7D-AF01F617B664`，写入 `AB5E0002`，音频通知 `AB5E0003`，控制通知 `AB5E0004`）。
- 仅保留 **HTT（Hold-to-Talk，按住说话、松手结束）** 模式（`trigger-modes="hold"`），界面不提供手动录音开关或按住/点击模式切换。
- 连接并订阅 `AUDIO`、`CONTROL` 通知后，主机发送 `GET_CAPS = 0A 01 00 00 03 03`（声明 ATVV v1.0、仅启用 HTT 位 `0x0003` 中与实机协商的交集并在会话层要求 `HTT` bit 置位、支持 IMA ADPCM 8 kHz/16 kHz）。兼容遥控器返回 ATVV v1.0（9 字节 `CAPS_RESP`）或降级返回 v0.4（7 字节 `CAPS_RESP`）。
- 会话状态机只在收到 `AUDIO_START`（v1.0 要求 `reason == 0x03` HTT；非 HTT 流立即回发 `MIC_CLOSE` 关闭）后进入 `STREAMING`，在遥控器松手上报 `AUDIO_STOP`、发生 `MIC_OPEN_ERROR`、流静默超时（5 s）或实例停止时退出。忽略 `START_SEARCH (0x08)`，不触发主机侧 `MIC_OPEN` 常开录音；流期间每 8 s 发送 `MIC_EXTEND (0x0E)` 保活。非 `STREAMING` 状态下到达的 `AB5E0003` 通知直接丢弃并计数。
- Windows 与 macOS 复用 `xiaomi_remote::voice` 的实例级 BLE GATT 工作线程、增益校准与虚拟麦克风输出（Windows `Quarbor Virtual Microphone`，macOS `MiRemoteV 2ch`），按实例绑定的 12 位蓝牙地址筛选目标设备（Windows 要求 `AB5E0001` 服务路径匹配绑定蓝牙地址及 `VID&010417_PID&0304` 或地址路径，避免误连其他同 VID/PID 的 RC902N/RC902V 实例）。RC902N 同样声明 `engine="tcl-rc902v-atvv"` 复刻此 HTT 语音链路。

## ADPCM 解码与重采样

- 使用无预设表头的连续 IMA ADPCM 解码器（每字节高 4 位 nibble 在前、低 4 位 nibble 在后），每段新语音流在 `AUDIO_START` 时将 `predictor = 0`、`step_index = 0` 清零，不在流内按包重置。
- 支持 `AUDIO_SYNC (0x0A)`：按协商的 `bytes_per_frame` 校验已完成帧计数（缺帧仅记录缺口统计，不填充假帧），并在帧边界将解码器对齐到上报的 `(predictor, step_index)`。
- 虚拟麦克风管线固定使用 16 kHz 单声道 `i16` PCM；当协商编解码为 `0x01`（8 kHz ADPCM）时，在送入音频输出前线性插值上采样至 16 kHz。`WavSink` 供独立工具或回归测试落盘标准 RIFF/WAVE 文件。

## 验证边界

- 已确认事实：RC902V 暴露 `AB5E0001` ATVV 服务及 `A` 键 HID 报告 `03 21 02` / `03 00 00`。
- 自动测试全部使用合成 ATVV 控制报文与合成 IMA ADPCM 向量，覆盖 `GET_CAPS`/`CAPS_RESP`（v1.0 与 v0.4）、HTT 流生命周期、非 HTT 流主动关闭、跨流解码状态隔离、非流态丢包、`AUDIO_SYNC` 帧对齐与缺口计数、`MIC_EXTEND` 保活、超时恢复、WAV 封装及 Windows 实例队列路由。
- 尚未采集 RC902V FMR1 实机 `CAPS_RESP` 原始字节、`AB5E0003` 单包通知长度及真实人声录音；实机蓝牙抓包与语音听感仍待硬件联调确认。
