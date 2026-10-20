# 常见问题与排障

[返回首页](../README.md) · [使用指南](USAGE.md)

- [macOS 无法打开应用或驱动安装包](#macos-无法打开应用或驱动安装包)
- [macOS 已授权但仍提示未授权](#macos-已授权但仍提示未授权)
- [Windows 重连或休眠后按键无响应](#windows-重连或休眠后按键无响应)
- [语音没有声音或影响其他音频](#语音没有声音或影响其他音频)
- [长时间说话时音频延迟](#长时间说话时音频延迟)
- [运行日志](#运行日志)

## macOS 无法打开应用或驱动安装包

部分发布包或本地构建使用自签名证书，未经过 Apple 公证，首次启动时可能提示“无法验证开发者”或“应用已损坏”。

确认文件来自本项目且校验和与 Release 页面一致后：

1. 将 DMG 中的 `Axonkey.app` 拖到“应用程序”，从该位置启动。
2. 在 Finder 中按住 Ctrl 点击应用，选择“打开”，按系统提示确认。
3. 如果仍被拦截，到“系统设置 → 隐私与安全性”的“安全性”区域点击“仍要打开”。
4. `MiRemoteV 2ch` 安装包被拦截时，对相应 PKG 使用同样的打开方式。

允许启动后，仍需单独授予输入监控和辅助功能权限。自签名证书用于保持应用身份，不等同于系统信任或权限授权。构建与证书维护见 [开发与发布](DEVELOPMENT.md#macos-签名与公证)。

## macOS 已授权但仍提示未授权

先确认运行的是“应用程序”中的 Axonkey，而不是 DMG 内的副本。

1. 在“系统设置 → 隐私与安全性”的“输入监控”和“辅助功能”中移除旧 Axonkey 条目。
2. 通过 Finder 重新添加当前 `Axonkey.app`，打开权限开关。
3. 回到 Axonkey 重新检测；系统要求退出并重开时，按提示操作。

macOS 权限与应用签名身份关联。换用不同签名的版本或频繁安装本地构建，都可能需要重新授权。

## Windows 重连或休眠后按键无响应

1. 唤醒遥控器，确认系统蓝牙仍已连接。
2. 在 Axonkey 的引导中重新检测设备与驱动，必要时重新连接遥控器或重新绑定驱动。
3. 若提示需要重启 Windows，重启后再试。

从旧版本升级时，如提示存在旧 Interception 驱动或重连修复服务，按引导清理后安装当前 Quarbor 驱动。旧修复服务已不参与当前输入链路，不需要单独补装。

仍无响应时，查看 [Windows 驱动排查](WINDOWS_INPUT.md#故障排查)，并提供问题发生时间及下方运行日志。

## 语音没有声音或影响其他音频

先确认已安装语音驱动，再在语音输入应用中选择对应麦克风：Windows 选择 `CABLE Output`，macOS 选择 `MiRemoteV 2ch`。按住遥控器语音键说话，必要时调整 Axonkey 的语音增益。

Windows 的系统和应用扬声器输出应保留真实扬声器或耳机，不要选择 `CABLE Input`。Axonkey 会自行将遥控器语音写入该虚拟设备，无需把它设为默认播放设备。微信输入法语音输入可能压低其他媒体音量或中断播放，遇到时先检查这两项设备选择。

## 长时间说话时音频延迟

长时间按住 RC003 语音键连续说话时，音频可能逐渐延迟。macOS 上已观察到约 1.8～2 秒延迟，松开时还可能丢失尾句，此问题尚未解决。

需要完整录制长段语音时请留意这一限制。测量记录和排查进展见 [RC003 音频延迟说明](RC003_AUDIO_LATENCY.md)。

## 运行日志

Axonkey 会在本地记录启动、设备连接、输入/音频服务、系统探测和命令失败等运行时信息，不会上传日志，也不会记录映射文本内容。主页“运行日志”按钮可以直接打开日志目录，反馈问题时可附上 `axonkey.log` 和相关滚动旧日志。

日志按文件大小滚动：单个文件达到 5 MB 后自动切换，并保留最近 5 个旧文件。Tauri 默认日志目录为：Windows 的 `%LOCALAPPDATA%\com.axonkey.app\logs`，macOS 的 `~/Library/Logs/com.axonkey.app`。Windows 驱动安装器日志位于 `%LOCALAPPDATA%\Axonkey\logs`；macOS MiRemoteV 安装和卸载日志位于 `~/Library/Logs/Axonkey`。

### Windows 音频诊断字段

Windows 音频链路常驻 INFO 级诊断，不需要开启调试模式。连接时记录协商的协议、编码、帧大小和 CABLE 输出格式；语音活动期间约每秒输出一条 `RC003 audio diagnostics`，短会话会汇入下一个统计窗口，连接关闭时补记剩余统计。空闲且没有音频数据或控制事件时不刷日志，不保存音频包内容、PCM 或识别文本。

- `window_ms` 为实际统计窗口长度，各计数是窗口增量，不是会话总量；跨线程计数是近似快照。`starts/stops/syncs` 统计收到的控制事件，不表示音频已经成功输出。
- `rx_packets/rx_bytes/last_rx_ms` 表示收到的音频通知数量、字节数和距最后一包的毫秒数（`never` 表示服务启动以来尚未收包）；`rejected_packets` 是因空包、未就绪或停止保护窗口等原因未进入解码的包数，`notification_read_errors` 是读取音频或控制通知失败的次数。
- `decoded_samples/pcm_peak/pcm_rms` 表示解码后的单声道样本数、峰值和 RMS（增益前的 i16 幅度，绝对满幅为 32768）。持续收包但这些电平接近零，说明解码后的信号近乎静音，不能单凭此项认定硬件故障。
- `output_callbacks/consumed_samples` 表示播放回调次数和从队列取出的 16 kHz 源样本数，不保证下游录音应用已收到声音。`unfilled_output_frames` 是因没有足够样本等原因填零的输出帧数（按输出采样率计，不等于内容本身静音）；`queue_busy_callbacks` 是未取得队列锁的回调数，`overflow_samples` 是队列溢出丢弃的源样本数。会话边缘和空闲窗口的填零是正常现象。
- `streaming/microphone_opened/session_id/queued_samples/gain_db` 提供控制状态、队列余量和增益上下文。排查只有按下瞬间有电平时，保持按住语音键连续说话约 10 秒，再提供包含开始、周期统计和停止事件的日志。

### macOS 音频诊断字段

macOS 同样常驻 INFO 级诊断，使用 `macOS RC003 audio diagnostics` 标识，共用收包、拒收、通知读取错误、增益前 PCM 电平和控制事件统计。每秒汇总，空闲不写日志，暂停或停止服务时补记并取消定时器；不保存语音内容。状态变化、协议协商、输出格式和语音命令提交也会进入运行日志。

- macOS 输出采用 AVAudioSourceNode 和有界 PCM 环形队列。`scheduled_samples` 是成功入队的 16 kHz 单声道样本数；`completed_buffers/rendered_samples` 由主线程轮询已取出的完整 PCM 块后累加，会有统计延迟，也不能证明下游录音应用已收音。`enqueue_failures/enqueue_failed_samples` 为入队失败的块数和样本数；`enqueue_invalid/enqueue_output_unavailable/enqueue_queue_full` 区分无效输入、输出未就绪和队列容量不足（Rust 桥未建立时不会调用原生入队，因此可能只有总失败数）。
- `pending_buffers/engine_running/output_prepared/output_verified/drain_requested` 表示待完成块数、引擎运行、输出节点存在、路由验证和尾音排空状态。`queued_samples` 是当前剩余样本，`underruns` 是窗口内非排空状态下队列耗尽次数。输出重置时，`discarded_pending_buffers` 统计尚未确认完成的块数，`discarded_queued_samples` 统计确实仍留在队列中的样本；部分已取出的块可能仍在待完成列表，二者不能直接按块大小换算。
- `audio_callbacks/callback_bytes/notification_min_bytes/notification_max_bytes` 在音频特征的回调入口统计（错误回调的 value 可能为空或是旧值，不代表新音频）；`callback_stale/callback_read_errors/callback_missing_value` 按处理顺序分别统计旧连接、读取错误、缺失 value。通过这些检查后才计入 `rx_packets/rx_bytes`；随后拒收按 `rejected_not_ready/rejected_empty/rejected_after_stop` 区分未完成协商、空包和停止后 300 ms 保护窗口，进入解码的通知计入 `accepted_packets/accepted_bytes`。控制通知错误仍包含在共用的 `notification_read_errors` 中。
- `callback_gap_ge20/ge50/ge100/ge250` 是语音会话内相邻有效连接音频回调入口间隔达到各毫秒阈值的次数，阈值累计计数；`max_callback_gap_ms` 为最大值。统计跨越一秒汇总边界，但不包含两次按键之间的静默。`max_callback_handler_ms` 包含本次回调中的协议处理、同步解码与入队耗时；`max_packet_gap_ms` 保留原有的接受包间隔。`callback_wait_ms=unknown transport_arrival=unknown` 明确表示无法观测 CoreBluetooth 回调前的排队时间或无线到达时间，不能将回调间隔直接解释成无线丢包。
- `rx_packets_per_second` 按实际窗口计算收包速率；`decoded_ms` 是解码样本对应的音频时长；`decoded_window_percent` 是该音频时长占整个统计窗口的百分比，**不是丢包率**。会话边缘、批量延迟到达都可能影响这个比例，甚至超过 100%。`decoder_pending_bytes` 是解码器当前不足一帧的残包字节数，`decoder_discarded_bytes` 是窗口内同步或会话重置时清掉的残包字节数；`connection_generation/session_id` 用于关联连接与会话。

这些统计借鉴了 remote-mic-app 的分段诊断思路，仅记录计数与时序，不调整蓝牙线程、协议或音频缓冲策略。分析持续断续时，应对照同一会话中部的连续窗口，检查回调供给、接受/解码、入队失败与欠载，避免只凭单个指标归因。

