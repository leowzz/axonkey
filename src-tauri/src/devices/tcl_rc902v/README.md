# TCL RC902V

图稿、27 个按键及原始 HID 采集位于 `public/device-descriptors/tcl-rc902v.svg`；来源为 `docs/device-drafts/tcl-rc902v.svg`。语音触发键为 `A`（`#key-assistant`，稳定 ID `tcl-rc902v.assistant`，HID 采集 `03 21 02` / `03 00 00`）。

## 录音与传输

- 采用 Google ATVV BLE GATT 通道（服务 `AB5E0001-5A21-4F05-BC7D-AF01F617B664`，写入 `AB5E0002`，音频通知 `AB5E0003`，控制通知 `AB5E0004`）。
- 能力协商主动采用 **On-request (legacy)（`0x00`）** 交互模型（`GET_CAPS = 0A 01 00 00 03 00`），并在此之上提供两种录音触发模式（`trigger-modes="hold click"`）：
  - 依据 Google Voice over BLE Spec v1.0 §4.5.1–§4.5.3，若通告 PTT（`0x01`）或 HTT（`0x03`），遥控器固件会按规范屏蔽 HID `KEYCODE_ASSIST`（`0x0221`，报告 `03 21 02` / `03 00 00`），导致主机在 PTT 模式下收不到二次按下或松开事件而无法停录；改用所有遥控器强制支持的 `On-request (0x00)` 后，每次按下 `A` 键固件都会保留 GATT `START_SEARCH (0x08)` 与 HID `03 21 02` / `03 00 00` 上报，且麦克风在收到 `MIC_OPEN (0C 00, Playback)` 后持续采音直至主机下发 `MIC_CLOSE`。
  - **按住录音，松开停止（`hold`）**：按下 `A` 键（`START_SEARCH` 或 HID 按下边沿）主机发送 `MIC_OPEN` 开启实时流，松开 `A` 键主机立即发送 `MIC_CLOSE` 停止远端麦克风并结束会话。
  - **点击开始，再次点击停止（`click`，默认）**：首次按下 `A` 键发送 `MIC_OPEN` 开始录音，松手后保持麦克风持续采音（流期间每 8 s 发送 `MIC_EXTEND` 保活）；再次按下 `A` 键（无论 GATT `START_SEARCH` 或 HID `03 21 02` 先到，或仅单一通道到达）立即发送 `MIC_CLOSE` 停止录音。切换录制模式、实例禁用、断连、`MIC_OPEN` 等待超时或流静默超时（5 s）时均主动发送 `MIC_CLOSE`。
- 连接并订阅 `AUDIO`、`CONTROL` 通知后，主机发送 `GET_CAPS = 0A 01 00 00 03 00`（声明 ATVV v1.0、能力协商仅请求 On-request `0x00`、支持 IMA ADPCM 8 kHz/16 kHz）。根据遥控器返回的 `CAPS_RESP` 版本严格分派 `AtvvV10`（`0x0100`，裸 ADPCM 流、`MIC_OPEN` Playback `0C 00` 与带 `stream_id` 的 `MIC_CLOSE`）与 `AtvvV04`（`0x0004`，6 字节帧头与无参 `MIC_CLOSE`），未知协议版本立即停止且不盲写控制指令；同时保留 PTT `AUDIO_START (reason=0x01)` 与 HTT `AUDIO_START (reason=0x03)` 回退兼容。非 `STREAMING` 状态下到达的 `AB5E0003` 通知直接丢弃并计数。
- Windows 与 macOS 复用 `xiaomi_remote::voice` 的实例级 BLE GATT 桥接、增益校准与虚拟麦克风输出（Windows `Quarbor Virtual Microphone`，macOS `MiRemoteV 2ch`），并将 HID 输入层的 `A` 键按下/松开边沿与录制模式同步至 `AtvvSession`；按实例绑定的 12 位蓝牙地址筛选目标设备（Windows 要求 `AB5E0001` 服务路径匹配绑定蓝牙地址及 `VID&010417_PID&0304` 或地址路径，避免误连其他同 VID/PID 的 RC902N/RC902V 实例）。RC902N 同样声明 `engine="tcl-rc902v-atvv"` 复刻此语音链路。

## ADPCM 解码与重采样

- ATVV v1.0 使用无预设表头的连续 IMA ADPCM 解码器（每字节高 4 位 nibble 在前、低 4 位 nibble 在后），每段新语音流在 `AUDIO_START` 时将 `predictor = 0`、`step_index = 0` 清零，不在流内按包重置，亦不剥离 v0.4e 6 字节头；ATVV v0.4e 在 `AtvvV04` 分支按帧读取 6 字节头中的 `(predictor, step_index)`。
- 支持 `AUDIO_SYNC (0x0A)`：按协商的 `bytes_per_frame` 校验已完成帧计数（缺帧仅记录缺口统计，不填充假帧），并在帧边界将解码器对齐到上报的 `(predictor, step_index)`。
- 虚拟麦克风管线固定使用 16 kHz 单声道 `i16` PCM；当协商编解码为 `0x01`（8 kHz ADPCM）时，在送入音频输出前线性插值上采样至 16 kHz。`WavSink` 供独立工具或回归测试落盘标准 RIFF/WAVE 文件。

## 验证边界

- 已确认事实：RC902V 暴露 `AB5E0001` ATVV 服务及 `A` 键 HID 报告 `03 21 02` / `03 00 00`。
- 自动测试全部使用合成 ATVV 控制报文与合成 IMA ADPCM 向量，覆盖 `GET_CAPS`/`CAPS_RESP`（v1.0 PTT/On-request/HTT 与 v0.4e，以及未知版本安全阻断）、`hold` 按住松开关闭、`click` 按下录音/再次按下停止录音（含 HID/GATT 不同先后到达时序）、模式切换主动关闭、跨流解码状态隔离、非流态丢包、`AUDIO_SYNC` 帧对齐与缺口计数、`MIC_EXTEND` 保活、超时恢复、WAV 封装及 Windows/macOS 实例路由。
- 尚未采集 RC902V FMR1 实机 `CAPS_RESP` 原始字节、`AB5E0003` 单包通知长度及真实人声录音；实机蓝牙抓包与语音听感仍待硬件联调确认。
