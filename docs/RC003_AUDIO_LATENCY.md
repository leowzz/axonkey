# RC003 cumulative audio delay investigation — 2026-09-16

Status: investigation resumed on 2026-10-13 after another report of stuttering;
unresolved on the physical remote. The September report included approximately
1.8–2 seconds of delay during long presses and missing speech at release.
Do not describe the application-side changes as a verified fix for these symptoms.

## 最新结论与下一步 — 2026-10-14

本次 HCI 与应用逐包对照确认：**音频时长不足在 HCI 接收记录中已经存在，
Axonkey 没有在收到这些包后再丢包。问题尚未解决，不能据此直接认定是 macOS 驱动故障。**

| 对照项 | 本次结果 |
| --- | --- |
| 语音包 | HCI 与应用均为 402 包，每包 120 字节；哈希、长度和顺序全部匹配 |
| 收包速率 | HCI 约 49.41 包/秒，应用约 49.45 包/秒；连续音频约需 66.67 包/秒 |
| 音频覆盖 | 开始至停止控制包间隔 8.132 秒，收到的 PCM 为 6.030 秒，覆盖约 74.15% |
| 最长包间隔 | HCI 133.0 毫秒，应用 132.6 毫秒 |
| 应用内部 | 逐包记录无溢出、无错误标志；无入队失败，96,480 个解码样本全部输出 |
| 测试设置 | 软件拉伸关闭，输出设备为 MiRemoteV；用户确认测试完成，未提供主观卡顿评价 |

覆盖不足不等于已经测得无线丢包率。HCI 是主机与控制器边界的记录，仍无法单独区分
遥控器未发送、无线干扰／重传，以及控制器／固件行为；本次证据也不能保证其他运行中
绝不会出现应用调度问题。PacketLogger 与应用时间戳存在偏移，本次采用包间隔对照，
不据此报告绝对回调延迟。

后续先保持软件、输出设备和其他条件不变，对照“近距离固定放置”与“平时位置和握法”
的 HCI 收包节奏。如果近距离仍不足，再与 Windows 的 HCI、连接参数和语音启动命令
进行对照。已有 Windows 正常测试来自另一台实体电脑，尚不能排除硬件与无线环境差异。
不再将软件拉伸作为解决这次上游音频时长不足的主要方向。

本次抓包已停止，应用单次逐包记录已结束；Apple 临时蓝牙日志描述文件已移除。
原始 HCI 和详细分析保留在本机私有目录，路径及技术证据见下节，不纳入 Git。

## 接收音频波形 — 2026-10-14

语音链路监测在内部音频队列图上方展示接收音频振幅包络，取自 ATV 解码后的 PCM，
位于增益、队列入队和软件拉伸之前，不代表虚拟麦克风实际输出。按本机解码回调时间
每 20 ms 汇总最小／最大振幅；空白表示已过滤起始音频或没有解码数据，接收到的零值音频显示在零线上。
接收突发会集中在到达时刻，不能把图表空白直接当作无线丢包或最终输出静音。
为避免按键机械冲击遮蔽语音，每次语音会话开始的前 3,200 个源采样（200 ms）不进入
波形统计；这只影响图表和波形 CSV，不修改转发 PCM。中途打开或清空监测不重复过滤。
波形图高 230 px；纵轴直接跟随当前可见波形峰值，留 5% 余量，最大 ±1。
不再按整数档位向上取整或给非零音频设 ±0.01 下限，避免小声音仍被压扁；
仅完全静音／无数据时使用 ±0.01 的稳定刻度。

仅在监测活跃时聚合，不保留原始 PCM，不在音频渲染回调中增加工作。波形与其他读数
共用时间范围、暂停、清空、标记和 CSV 导出；新增 5 秒范围用于观察短暂停顿。
后端最多保留 10 分钟／30,100 个包络点，前端按显示像素合并极值，避免绘制原始采样。

## 高频监测与队列读数 — 2026-10-14

用户补充的实测：手完全包住遥控器时约 −62 dBm、40–50 包/秒；尽量不遮挡时约
−53 dBm、50–60 包/秒；机器旁约 −39 dBm、65 包/秒。这支持位置／握持影响交付速率，
但不是同时控制距离、朝向和握法的实验，尚不能区分天线遮挡、干扰或控制器行为。

应用内监测页改为约每 200 ms 读取一次队列并请求 RSSI，RSSI 等待实际回调，已有请求
未完成时不重复堆积（超时后重试）。收包速度使用独立累计计数和单调时钟计算最近约
1 秒的滚动速率，不提高持久化诊断日志频率；增量传输与有界历史避免长期监测放大负载。

新增 PCM 队列当前占用、刷新间入队峰值、容量线、消费至空、容量不足拒收和程序重置
计数。容量 4,096 个采样，按 16 kHz 折算为 256 ms；开启拉伸时这不是精确播放延迟。
事件归属到前一采样区间，界面时间不是事件精确发生时刻；短暂排空／拒收即使发生在
两次刷新之间也会保留计数。程序重置另记丢弃采样，不能当作正常播放排空。
这些读数不包含遥控器、蓝牙控制器或目标输入法内部缓存。

“清空历史”清掉监测历史和位置标记，重新建立计数基线，不修改音频队列或中断语音。
默认显示最近 30 秒，保留 1／3／10 分钟范围；CSV 包含毫秒时间、队列容量及事件计数。
独立 Python 日志页仍受原日志频率限制，不能显示新增的原生实时队列。

用户完成本机验证并使用“清空历史”。导出文件保存在私有目录
`~/Library/Logs/Axonkey-HCI/queue-test-20261014-1717.csv`，不纳入 Git。
143 个队列／收包读数的间隔中位数为 201 ms；30 个 RSSI 读数间隔中位数为 1052 ms，
说明当前实机 RSSI 回调并未随请求频率提高到 5 Hz。图中保留实际信号点，不插值伪造读数。
本轮队列峰值 38.6875 ms、消费至空 59 次、容量不足拒收 0 次、程序重置 0 次，末读数为 0。
本轮没有应用 PCM 队列堆满后清空的证据；反复耗尽与前述音频交付不足一致。


## 当前连接参数与无线模式线索 — 2026-10-14

继续检查已有抓包及同一连接 0x0042 的 bluetoothd 日志，未再次开启采集或更改连接参数：

- 重启后 15:21:08 建立连接时为 30 ms，15:21:10 已更新为 **15 ms、peripheral latency 0**；
  后续与本次采集相邻的带宽日志仍记录 15 ms。此前的 15 ms 结论现在有重启后这条连接的证据。
- 15:21:08.898 `PhyUpdateComplete` 成功，`txPhy=0x0002, rxPhy=0x0002`；
  说话期间控制器统计也有 2M 活动，说明本次采用 **LE 2M PHY**。Windows 对照机的 PHY 未知。
- 第二次 HCI 的 828 个包间隔中，722 个落在 15 ms 整数倍附近（±2 ms）；
  常见间隔约 15、30、45、60 ms，没有小于 5 ms 的集中补发。第一轮也有类似分布。
  这与连接节奏上的交付空缺一致，但不能仅凭分布判定是无线重传还是遥控器未发送。
- 第二次说话期间 RSSI 23 个统计点为 −62 至 −59 dBm，均值 −60.9；
  按键前后有较强读数。位置／握法影响仍是候选因素，不能仅凭 RSSI 宣称因果。
- 同期日志中 `rx[S:F]` 的 F 计数非零；这些厂商字段的语义未核实，不能当作
  ATT 丢包数、无线重传次数或直接计算丢包率。

[Bluetooth SIG 的 LE primer](https://www.bluetooth.com/bluetooth-le-primer/)
将 1M 与 2M 列为不同的 PHY，并说明它们有不同的速率与近似覆盖范围。
因此比较两台电脑实际协商的 PHY 有意义，但目前没有证据证明 2M 本身导致本问题。
本机 SDK 的 CoreBluetooth 公开头文件未找到 central 侧强制选择 PHY 的接口；
`CBPeripheralManager.setDesiredConnectionLatency` 属于外设角色，不适用于当前 Mac 作为
central 的连接。没有添加私有接口或全局蓝牙配置来强改 PHY。

用户确认 Windows 对照机暂时不方便使用，当前先只查 Mac：做固定位置、固定握法的
短时对照，改变单一条件。Windows 正常连接的 PHY、连接间隔、MTU／数据长度及语音
通知节奏留待设备可用时比较。
本机证据保存在第二轮私有目录的 `controller-stats.log` 和 `connection-parameters.log`。

## 参考仓库的同类反馈 — 2026-10-14

已查阅 `HD838A/remote-mic-app` 的相关 issues 和评论。以下两条在检查时均为 open，
讨论中未见维护者确认的根因或已验证修复；用户报告不能替代本机 HCI 证据。

- [#297：音频到达速率低于实时、末尾截断](https://github.com/HD838A/remote-mic-app/issues/297)，
  2026-08-29 提交，macOS / M1 Pro，日志设备为 **RC001**。报告者统计 76 个至少 2 秒的
  会话，收到音频时长与会话时长的比值中位数 89.8%，应用无入队失败，停止时队列只有
  数十毫秒。这与本机持续音频时长不足的表现相似，但设备型号不同，且其未提供 HCI 对照。
  文中“17.5 ms 连接间隔”及“遥控器积压并在松手时丢弃”属于推测；本机已经测得
  15 ms 连接间隔，不能照搬该解释。
- [#527：小米 Pro 在 macOS 下需多按几秒才能完整出字](https://github.com/HD838A/remote-mic-app/issues/527)，
  2026-09-29 提交。报告者在
  [10 月 9 日评论](https://github.com/HD838A/remote-mic-app/issues/527#issuecomment-6072718895)
  中补充 RC003、豆包输入法测试，称失败短句的原始录音完整，软件松键早于播放排空约
  38 ms，并建议先排空、再延迟松键。其输入法末段提交机制的解释来自 AI 辅助分析，
  未获维护者确认。这提示另一种停止时序问题，不能解释本机已经在 HCI 中存在的持续缺口。

结论：参考项目在 Mac 上也有相似报告，尚未找到可直接采用且已验证的通用修复。
当前继续区分“持续收包不足”和“停止时截断”两类问题；不因上游猜测重启软件拉伸，
也不将延迟松键当作持续收包不足的修复。

## 说完后保持按键 2 秒：复测结果 — 2026-10-14 15:57

用户澄清此前漏掉的是说完后仍按住语音键等待 2 秒，再松开；本轮已确认执行。
第一次采集没有控制这一步，因此不用于证明立即松键是否截断延迟的尾音。

本轮语音开始／停止控制通知间隔 **22.411 秒**，HCI 收到 **829 包**（每包 120 字节），
平均约 **36.99 包/秒**，对应 **12.435 秒 PCM**，按键期间音频时长覆盖约 **55.49%**。
应用持续统计同为 829 包，198,960 个解码样本全部输出，无拒收或入队失败，拉伸关闭。
最长 HCI 包间隔约 165 毫秒，应用对应区间也有相同停顿。

诊断逐包 CSV 的上限是从首包起 20 秒，本次超过上限：前 **742 包**与 HCI 按哈希、
长度及顺序全部匹配；剩余 87 包仅做应用总量统计对照，不宣称尾部完成逐包验证。
CSV 无溢出、错误标志为零。最后 2 秒收到 **69 包**，约 **1.035 秒 PCM**，未见明显
加速补发；末包在停止通知前约 30 毫秒，停止通知后本次没有后续语音包。

补上等待操作后仍有持续收包不足，不能将问题归结为漏等尾部 2 秒。是否保留了完整
语音尾句、声音相对说话时刻到底延迟多少，仍需同步音频参考；用户未提供主观评价。
此轮也不能区分遥控器未发送、无线干扰／重传或控制器行为。

本机私有目录：`~/Library/Logs/Axonkey-HCI/tail-wait-6rklccwg`，含 `analysis.md`、
`tail-wait.pklg`、`app.csv`、匹配结果及 `app-session.log`，不上传或提交原始数据。
本轮重新安装诊断配置后已实际收到 HCI，无需再次重启。抓包与逐包记录均已停止；
本轮临时蓝牙诊断描述文件已移除，系统设置仅保留原有 Stay on Sequoia 配置。

## First paired HCI/application capture — 2026-10-14 15:46

After installing Apple's signed Bluetooth logging profile and rebooting,
PacketLogger successfully captured real HCI traffic. The diagnostic application
was installed with the same certificate/designated requirement as the previous
installed version. Local capture directory:
`~/Library/Logs/Axonkey-HCI/capture-hcoq4vtw` (`analysis.md`, `remote-voice.pklg`,
`app.csv`, `matched.json`, `hci-notifications.json`, `app-session.log`). This private
directory contains sensitive HCI payloads; do not upload or commit it.

The 15:46:23–15:46:31 voice run yielded 402 incoming 120-byte audio values on
connection 0x0042, ATT attribute 0x0304. PacketLogger metadata identifies the
connection as the Xiaomi remote. All 402 application callbacks for audio UUID
AB5E0003 match those HCI values by SHA-256, length and order. No unmatched audio
values, callback error flags, trace overflow or incomplete ACL/L2CAP reassembly
were observed. HCI first-to-last span is 8.115 s (49.41 intervals/s); app span is
8.109 s (49.45 intervals/s). The start/stop controls span 8.132 s, while received
PCM covers 6.030 s (74.15%); this is duration coverage, not measured RF packet loss.

Maximum gaps are 133.0 ms at HCI and 132.6 ms at callback entry, with five ≥50 ms
gaps and one ≥100 ms in each timeline. Corresponding gap differences have absolute
median 0.096 ms, p95 0.471 ms and maximum 5.607 ms. The raw PacketLogger timestamps
have an eight-hour offset against app Unix time plus a small residual offset;
use interval comparisons, not absolute latency claims. All 96,480 decoded source
samples were rendered, with stretch off and no enqueue failures.

For this run the duration deficit is already present at the HCI capture point;
application notification loss or long callback stalls do not explain it. HCI
cannot distinguish remote non-transmission, radio interference/retries or upstream
controller/firmware behavior. Remote HID latency notes also occur while voice is
idle and have unverified semantics; do not interpret them as measured audio delay.
The decoded ATT Attribute Not Found errors belong to another connection (0x0048).
Next useful experiment is fixed close placement versus normal grip with paired
HCI traces, then a Windows HCI comparison if the close-range deficit persists.
The user confirmed the test ended but supplied no subjective quality rating.
Both traces are stopped/sealed. The user completed administrator authentication
for removal of `com.apple.bluetooth.logging`; System Settings now lists only the
pre-existing Stay on Sequoia profile. The temporary Bluetooth logging profile
has been removed.

## HCI/application alignment preparation — 2026-10-14

The next measurement compares the same audio notifications at HCI and at
CoreBluetooth callback entry. Apple's
[Bluetooth tools page](https://developer.apple.com/bluetooth/) points to Additional
Tools for Xcode. The user downloaded `Additional_Tools_for_Xcode_16.3.dmg`.
Its image checksum and PacketLogger code signature verified; the application is
installed at `/Applications/PacketLogger.app` (version 2024.03.18, minimum macOS
14). A preliminary live trace received zero HCI/ACL packets and was stopped.
Initial automated and manual downloads of the official macOS Bluetooth logging
profile/instructions failed. Local bluetoothd logs say `PacketLogger authenticated`,
but that does not establish that packet-level logging is enabled. The bundled
`Contents/Resources/packetlogger --help` documents `convert -o FILE` for live HCI
capture; a non-root run reports `Live traces require root privilege`, and
`sudo -n` reports that a password is required. A private, temporary wizard was used to
run this official CLI for 10 seconds, then stop its process group and report
HCI/ACL record counts. It makes no Bluetooth/security configuration changes.
The wizard path was recorded in `/tmp/axonkey-hci-wizard-current-path`; these
temporary wizard/probe files were cleared on reboot and are no longer available.
The user completed administrator authentication. The 10.02-second probe exited
normally and produced a 260-byte file containing one type-252 Note record,
`Disconnected from OS X Device`, with zero HCI/ACL records. At 14:48:15 local time,
bluetoothd logged `PacketLogger authenticated`, `Starting Live Logging`, and then
`Bluetooth Profile Required`. This explicitly establishes the capture prerequisite
as the blocker; zero captured packets must not be interpreted as remote packet
loss. The result is under `capture-aive5c0n` in the wizard directory. No capture
remains running. Administrator privilege alone did not enable this trace.

The user subsequently downloaded `~/Downloads/Bluetooth_macOS.mobileconfig`
and `~/Downloads/Bluetooth_Logging_Instructions.pdf`. OpenSSL 3 CMS verification
succeeded, and `security verify-cert` verified the signer/intermediate against
system trust. The signer is AppleCare Profile Signing Certificate (Apple Inc.).
The system-scoped `com.apple.bluetooth.logging` profile enables Bluetooth debug
and private-data logging, firmware logging and HCI traces; it expires after three
days and can be removed earlier. It may log sensitive data from other Bluetooth
accessories, so keep the measurement bounded and local; no upload is authorized.
The official PDF explicitly requires installing the profile and rebooting before
reproducing the issue. After the profile was opened, the user completed the
installation in System Settings; its Device Management list now shows
`Bluetooth Logging for macOS` under Device with three settings, rather than
Downloaded. The existing Stay on Sequoia user profile was left untouched.
The user rebooted at 15:20:51 on October 14. The subsequent paired capture is documented above.
After reboot, first verify nonzero HCI/ACL capture, then install/launch the matching
application trace build and collect paired traces with a 5–8-second voice test.
Remove the Bluetooth logging profile after measurement. These preparation steps are now complete; see the paired capture above. The
diagnostic build and native tests passed before installation.

After reboot, TCC logged code-requirement mismatches for the debug executable
`src-tauri/target/debug/axonkey` (including Accessibility and Bluetooth). The
existing `~/Library/LaunchAgents/Axonkey.plist` incorrectly launched that ad-hoc
signed executable. Its current designated requirement uses CDHash `2cf87b93…`,
while the saved grants referenced `53781097…`. The installed application retained
its pre-reboot signing identity and certificate requirement (root `7725c132…`),
and passed strict signature verification. The startup plist was backed up, its
executable changed to `/Applications/Axonkey.app/Contents/MacOS/axonkey`, then
unloaded/reloaded with launchctl. The installed app is now running; at 15:41:06,
TCC returned allowed (authValue=2) for ListenEvent, Accessibility, PostEvent and
Bluetooth. No TCC database reset or signature change was performed. This fixes
the local stale startup target; source-level prevention of debug autostart
registration has not yet been implemented.

An opt-in `AXONKEY_AUDIO_TRACE_PATH` environment variable now enables a one-shot
application trace. Use an absolute, previously nonexistent CSV path in a private
local directory. With the installed application fully quit, launch the matching
diagnostic build with:

```sh
open -a /Applications/Axonkey.app --env AXONKEY_AUDIO_TRACE_PATH=/absolute/private-directory/app.csv
```

Start HCI capture first, then hold the voice key for 5–8 seconds. Application
tracing begins on the first audio-characteristic callback and seals after 20
seconds (or a normal audio-service stop). It stores up to 8192 callback records in
memory, then writes on a utility queue; no per-packet disk writes are performed.
Normal launches have tracing disabled. Each row contains Unix and monotonic
timestamps, byte length, session ID, error/stale flags, and a SHA-256 digest of the
notification value. Raw voice payload is not exported by the application trace;
an HCI capture can contain it and other Bluetooth traffic, so keep the capture
local and bounded. CSV creation uses exclusive open and mode 0600. Forced process
termination before export can lose the in-memory trace.

Match complete incoming ATT audio values by length and digest, retaining order;
reassemble fragmented HCI ACL/L2CAP data first. Duplicate payload hashes need
sequence/time disambiguation. Do not identify audio solely by its 120-byte length:
verify the peripheral/connection and audio characteristic handle. Exclude trace
boundaries, flagged callbacks, truncated captures, and any overflow from causal
claims. Use monotonic intervals for application gaps; Unix timestamps align the
two sources, subject to clock adjustments and the capture tool's timestamp
semantics. The trace's session ID is the value at callback entry, before any
session-start handling for that packet.

If HCI is complete but application callbacks are missing or late, investigate
delivery/scheduling. If both are short, investigate upstream transport; HCI alone
cannot distinguish a peripheral that did not transmit from radio-layer failure.
This instrumentation does not modify buffering, routing, decoding or stretching.

## Recording 12222.m4a — 2026-10-14

The supplied 18.048-second AAC container decodes to 18.004 seconds of 48 kHz
stereo; both channels are identical. It was saved at 14:10:40. Its per-window
energy matches session 126 (14:10:15–14:10:31): aligning the first diagnostic
window end to 0.711 s in the file gives a 0.9995 correlation between recorded
energy and `pcm_rms² * decoded_samples` over the interior windows. File save time
alone was not treated as recording start time.

Using non-overlapping 5 ms RMS windows, 48.9% of the file lies below -70 dBFS;
excluding the first/last approximately one second still leaves 45.1% below that
threshold. This is an energy measurement, not a speech/pause classifier. Frequent
short gaps in the waveform are corroborated by 151 queue exhaustions in the
15.995 seconds of interior diagnostic windows. Those windows contain 548 packets:
34.26 packets/s, 8.22 seconds of source PCM, or 51.39% of realtime coverage.
Maximum callback-entry gap is 149.6 ms; maximum handler duration is 0.244 ms.

All windows have `stretch_enabled=0`. Across the complete session, 571 packets
produce 137,040 decoded, scheduled, and consumed source samples, with zero enqueue
failures and zero discarded queued samples. Thus the source-sample accounting
balances while incoming audio duration is insufficient; this does not establish
physical packet loss versus upstream delay or callback scheduling. The matched
bluetoothd RSSI samples range from -66 to -62 dBm (mean -63.6); they alone do not
identify the cause. Gain is +16 dB with 238 clipped source samples, a secondary
quality issue that cannot explain the missing half of the audio duration.

No further audio algorithm changes were made based on this recording. Stretch
remains disabled. Further investigation must distinguish the macOS Bluetooth
receive/delivery path from RF conditions, rather than infer driver failure or a
successful fix from the output queue counters alone.

## Stretch compensation rejected in real use — 2026-10-14

The user reported worse stuttering after enabling the stretch experiment. The
setting now defaults **off**; the current installation was already switched off
by the user, confirmed by `enabled=0` at 14:07:13. Preserve that saved choice.
Keep the signal monitor available for diagnosing the underlying receive path.

The synthetic test used a continuous 220 Hz tone, 40–49 packets/s, and only
±5 ms packet jitter. Its output coverage and pitch checks do not establish
speech intelligibility, perceptual continuity, or behavior under real bursts.
In session 114, interior windows delivered 9–13 packets/s with callback gaps up
to 241.4 ms. Session 118 delivered 16–36 packets/s in interior windows and still
had 2–4 stretch underruns per window. The stretch renderer re-primes on starvation,
waiting for 960 input samples; repeated starvation can therefore add pauses to
time-stretched fragments. Underrun counts are not directly comparable to the
plain renderer and must not be treated as proof of better audible continuity.

After disabling compensation, session 121 still delivered 27–34 packets/s with
gaps up to 207.7 ms. This is not a controlled on/off comparison and cannot assign
the receive deficit to stretch or RF conditions. It does show that disabling
stretch alone has not demonstrated resolution of the receive problem. Do not
re-enable by default or claim a fix from synthetic coverage tests.

## Built-in signal monitor — 2026-10-14

On macOS, Settings → Device & Permissions → 遥控器信号 → 查看信号与收包
opens a bundled application window. It does not depend on Python, port 8766, or
system-log access. RSSI is requested at most once per second with public
CoreBluetooth `readRSSI` on the audio service's existing connected peripheral;
it does not scan or establish a second connection. The standalone diagnostic
page still reads bluetoothd logs, so the two sources may differ in sample timing.

Voice packet rate and underruns reuse the audio diagnostics windows. Packet rate
is `rx_packets * 1000 / window_ms`, before stretch compensation. The 66.7 packets/s
line remains the RC003's unmodified realtime requirement, not a Bluetooth limit.
The monitor keeps at most ten minutes / 1,200 points per series in memory, records
no audio, expires live readings after five seconds, and clears the current rate
on voice release. Closing the window stops RSSI polling and clears its history.
CSV export uses the system save dialog.

Verified in the signed installed app: Settings entry, native window, live RSSI,
mark/pause controls, scrolling, and CSV file contents. Automated tests cover
window-normalized rates, stale data, session transitions, disconnects, invalid
RSSI, and bounded history. This UI validation does not establish that radio
stuttering or the perceived quality of stretch compensation is resolved.

## Controlled follow-up — 2026-10-14

The normal Windows comparison uses **another physical computer**, not a VM on
this Mac. It controls the remote and application, but not the Bluetooth radio or
RF environment. The Mac currently has only the remote connected over Bluetooth;
Wi-Fi uses channel 36 / 5 GHz. Disconnecting the EDIFIER headphones did not remove
the deficit in session 94 (43.73 packets/s over 9.994 seconds).

The diagnostic build at `5f5c8c1` changes counters, not audio forwarding. In session
95 at 12:25:48–12:25:57, the user reported that speech recognition sounded normal.
However, seven interior windows (6.997 seconds) still delivered 49.02 packets/s,
73.53% of realtime PCM, and 55 queue exhaustions. No notifications were rejected
and no enqueue failed. Maximum callback handling time was 0.366 ms, while the
largest callback-entry gap was 89.9 ms. Successful recognition alone is therefore
not a sufficient acceptance test for uninterrupted audio.

A separately signed, receive-only CoreBluetooth probe then used a dedicated
serial queue, the same ATVV capability request and HTT session protocol, and no
decoder, Core Audio, MiRemoteV output, or Axonkey HID capture. macOS's own HID
connection remained present. Session 96 lasted 26.223 seconds and delivered
1,467 × 120-byte notifications: 22.005 seconds of 16 kHz PCM equivalent, or 83.92%
coverage / 55.94 packets/s. Its maximum measured handler time was 0.361 ms and
largest gap 239.5 ms. It stored only counters, not audio. The remaining deficit
shows that the application decoder/output/HID implementation is not necessary
for the problem to occur. The difference between 49 and 56 packets/s is **not** a
controlled estimate of a background-queue improvement: the sessions occurred at
different times with changing link quality.

An independent silent production-bridge probe measured 160 operations per phase,
15 ms apart, without capturing audio or changing default devices:

| Operation | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Verify output route | 0.026 ms | 0.057 ms | 0.271 ms |
| Ensure running output | 0.027 ms | 0.058 ms | 0.103 ms |
| Enqueue PCM | 0.034 ms | 0.082 ms | 0.156 ms |

There were no failures. A separate first route query reached 18.2 ms; cold graph
creation took 250 / 496 ms in two runs. These can affect startup or isolated
events, but the measured steady-state cost does not explain persistent missing
audio. This probe does not measure waiting before the real application's callback.

Unlike the older unassociated parameter logs, current bluetoothd records can be
linked to RC003 by controller handle and its VID/PID:

- The original handle `0x4D` used a 15 ms interval and peripheral latency zero.
  Application restart at 12:25:31 did not disconnect this physical link.
- System Settings → remote details → Disconnect at 12:28:56 really disconnected
  `0x4D`. The system HID client automatically reconnected as `0x5D` at 12:28:57.
  Its initial 30 ms interval changed to 15 ms at 12:28:59, latency zero.
- The new link negotiated data length 251 in both directions and remote MTU 247
  (527 was the central's proposal, not the negotiated result). A 120-byte audio
  notification fits; missing MTU/DLE negotiation is not supported.
- Idle RSSI was approximately -44 dBm; during speech it was often -59 to -65.
  At 12:27:42, RSSI reached -71 and the controller's internal `rx[S:F]` counters
  were `14:31`; after recovery to approximately -60, the S counter returned to
  around 60 per second. The F field is undocumented here and must **not** be
  presented as an ATT packet-loss rate. Position, hand attenuation, interference,
  and device transmit behavior remain candidates, not proven causes.

Switching between an ad-hoc diagnostic build and the project's normal signing
identity triggered a separate macOS Bluetooth TCC code-requirement mismatch. The
user restored permission and the installed `/Applications/Axonkey.app` resumed
audio at 12:32. Future reproductions should keep a stable signed identity to
avoid introducing permission changes as a confounder. No driver was replaced.

### Position / grip comparison

The user completed shorter versions of the requested comparison, without another
build, driver, or connection change. Session 99 (12:34:30–12:34:41) used the usual
position/grip; session 100 (12:34:49–12:35:01) placed the remote on the desk about
20–30 cm from the Mac, holding the button with minimal coverage of the body.
Both used the installed 0.3.27 and the same controller handle `0x5D`.

| Condition | Interior app window time | Packets/s | PCM / window time | Queue exhaustions/s | Mean RSSI |
| --- | ---: | ---: | ---: | ---: | ---: |
| Usual position / grip | 9.995 s | 49.82 | 74.74% | 8.90 | -65.2 dBm |
| Near Mac / minimal coverage | 11.997 s | 64.52 | 96.77% | 1.75 | -52.3 dBm |

Enqueue failures and rejected notifications were zero in both. RSSI values use
ten complete controller windows per condition, offset from the app's timer:
12:34:31.953–40.988 and 12:34:51.019–12:35:00.050. Over those ten windows,
bluetoothd's internal `rx[S:F]` totals changed from `504:116` to `651:6`; these are
controller counters, not measured ATT loss fractions. The approximately 13 dB
signal improvement and matching controller/application delivery improvement
strongly support RF conditions, placement or hand attenuation as a major factor.
Distance and grip changed together, so this does not distinguish the two or
identify a particular interference source or antenna defect.

This is a substantial improvement, **not a complete fix**: the nearby condition
still fell below full realtime coverage and had queue exhaustions. Prioritize
making the normal operating position work reliably: improve line of sight and
Mac placement and separate nearby USB 3 / Thunderbolt equipment or shielding
objects. Apple's [wireless interference guidance](https://support.apple.com/en-us/102319)
supports these as candidate mitigations; no particular peripheral was isolated
as an interferer in this test. Do not require long repeated user recordings merely
to repeat the same result. Further controlled evidence is needed before changing
the audio driver or claiming long-term reliability.

If delivery remains deficient with good RF conditions, aligned HCI notification
and application callback counts are the next distinction; HCI alone still cannot
distinguish remote non-transmission from radio failures. Apple's
[central-side connection-parameter guidance](https://developer.apple.com/forums/thread/770717)
does not provide an API to force this remote's connection interval. Do not turn a
private latency request, larger playback buffer, or repeated reconnect into an
asserted root-cause fix.

### Experimental adaptive stretch compensation

macOS Settings → 设备与权限 offers **软件拉伸补偿（实验）**, now default off after the real-use regression reported above.
An explicitly saved off preference is preserved.
It uses a bounded WSOLA-style overlap/add stage after PCM decoding, before the
existing verified MiRemoteV output. Ten-millisecond synthesis hops and a 5 ms
alignment search preserve local waveform periodicity; queue feedback adjusts
source consumption between 0.55x and 1.08x. Initial buffering is 60 ms, with
steady-state queue depth depending on delivery rate. It does not change the
remote codec, BLE traffic, output device, or received-packet counters.

Switching is rejected while a microphone session or unplayed tail is active.
Disabling restores the original render path. Complete outages still become
silence and rebuffer; stop drains the accepted source tail without infinite
repetition. Diagnostics add `stretch_enabled`, `stretch_rate` (source samples
per synthesized output sample), and `stretch_output_samples`; existing
`rendered_samples` continues to account for source PCM consumption.

Deterministic 8-second simulations with 40 / 44.5 / 49 packets/s and alternating
5 ms arrival jitter produced uninterrupted output after startup, kept a 220 Hz
test tone at 220 Hz, and recovered to approximately 1x when arrivals returned to
66.7 packets/s. These tests verify synthesis and queue behavior, **not recovery
of lost speech or real-world recognition quality**. Already missing words or
ADPCM predictor corruption cannot be reconstructed. Large stretches may produce
artifacts and add latency; hardware listening acceptance is still required.

### Local live signal dashboard

From the repository root, run `python3 scripts/bluetooth-signal-monitor.py` and
open <http://127.0.0.1:8766>. Stop the server with Ctrl-C; `--port` selects another
local port. Python 3.9+ and the existing Axonkey diagnostic log are used, with no
third-party dependencies. Run parser/server checks with
`python3 test/bluetooth-signal-monitor.test.py -v`.

The page plots raw RSSI and audio packets/s on the same timeline, retains up to
ten minutes in memory, and offers position markers, pause/resume, and CSV export.
It reads bluetoothd logs and binds RSSI to the remote's VID/PID-confirmed controller
handle; disconnection or handle reuse requires fresh identity evidence. Missing
or stale values are shown explicitly. Audio stop windows are retained as history
but do not remain live readings. Startup/stop windows are partial speech windows
and should not be treated as steady-state throughput.

This standalone tool does not connect to Bluetooth, record audio, or alter the
running Axonkey app, driver, or system permissions. It listens on loopback only
and does not expose device addresses or raw log messages to the browser.

## Follow-up — 2026-10-13

The user confirms that the **same RC003 and Axonkey on Windows** do not exhibit
the obvious stutter/delay. This is a useful host comparison, but no simultaneous
Windows packet-rate measurements are available. The installed macOS app reports
0.3.25; MiRemoteV2ch.driver reports 0.7.1. Source inspection at 6b0fbd3 shows both
platforms send the same capability request (`0a 01 00 00 03 03`) and share the
16 kHz ADPCM decoder. Windows prebuffers 20 ms and macOS 30 ms; that difference
does not account for seconds of missing delivery.

Evidence from `~/Library/Logs/com.axonkey.app/axonkey.log`, sessions 60–63 around
11:22–11:23 China time, excluding windows containing START/STOP and keeping
950–1050 ms windows:

| Session | Observed seconds | Received packets/s | Decoded audio seconds | Queue exhaustions/s | Largest packet gap | Largest sampled queue |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 60 | 5.997 | 45.69 | 4.110 | 8.50 | 88.1 ms | 30.0 ms |
| 61 | 4.998 | 45.22 | 3.390 | 8.60 | 104.7 ms | 32.3 ms |
| 62 | 14.994 | 45.89 | 10.320 | 9.00 | 89.6 ms | 28.0 ms |
| 63 | 12.993 | 43.48 | 8.475 | 8.54 | 119.9 ms | 30.0 ms |

All these windows have zero enqueue failures, discarded pending buffers,
notification read errors, rejected packets, and codec syncs. Each packet carries
120 bytes / 240 samples / 15 ms; realtime delivery requires 66.67 packets/s.
Session 63 therefore supplies only about 65% of realtime PCM. These are delivery
deficits, **not a measured packet-loss percentage or end-to-end delay**. Queue
sizes are periodic snapshots, not continuous maxima. First packet / first render
for session 63 occur 17.1 / 48.1 ms after the application session starts; this is
not measured from the physical button press or at the receiving application.

Independent macOS unified logs from bluetoothd between 11:20:00 and 11:24:20
contain 92 `HID lag issue is detected` messages for VID 0x2717 / PID 0x32b8,
matching RC003. This corroborates a contemporaneous Bluetooth/HID issue but does
not identify the ATVV cause or distinguish radio retries, controller scheduling,
remote buffering, and application callback scheduling. The filtered logs did not
provide current connection interval, MTU, or retransmission counts; the September
values below must not be treated as October measurements.

The supplied `~/Downloads/axon麦克风卡顿.m4a` is approximately 15.3 seconds,
48 kHz stereo AAC. FFmpeg decoding at the original stereo rate produced 1,466,240
scalar samples, **all exactly zero**. Mono decoding also produced only zeros.
It cannot establish the audible stutter or acoustic latency; its creation metadata
alone cannot align its capture interval to a voice session.

Current evidence locates a sufficient cause of discontinuous output before the
virtual driver's input: the source PCM queue repeatedly runs out because too
little audio arrives. A separate downstream fault is not excluded. The historical
driver-only loopback measurement below is evidence against blaming MiRemoteV
alone, but was not repeated today. Increasing prebuffering cannot repair sustained
delivery at 43–46 packets/s and would add delay.

Next discriminating measurements are a matching Windows diagnostics sample and a
macOS controller/GATT trace aligned with application callback timestamps. A fresh
remote connection and a controlled mapping-enabled/disabled comparison can test
connection state and HID interaction; no such comparison has yet been performed.
Avoid claiming a specific Bluetooth driver or firmware defect without that evidence.

Validation: `node --test test/macos-audio-tail-drain.test.mjs` passed both native
tests, including PCM queue AddressSanitizer/UndefinedBehaviorSanitizer coverage.
This verifies queue behavior, not physical Bluetooth delivery. No production code,
driver installation, or shelved experiment was changed during that initial check.

### Subsequent speaker feedback and silent recording

At approximately 11:31 the user reported hearing remote speech through the real
output after quitting QuickTime. QuickTime was absent from the process list.
Read-only Core Audio process/device snapshots during two reproductions showed
Axonkey as the only active audio-output process and EDIFIER W820NB as the active
device, while MiRemoteV was idle. The initial snapshots used the global scope for
per-process device lists (which returned empty); device activity and process
activity were observed separately. This establishes a downstream routing problem
in addition to the receive-rate deficit, and explains how recording MiRemoteV can
produce silence. It does not establish when or what redirected the engine.

The existing Settings → Device and permissions → Restart driver action was run
at 11:32:37. The user confirmed feedback disappeared. Subsequent snapshots at
11:34:19 and 11:34:34, using the correct output scope, showed Axonkey outputting
to device 113, MiRemoteV 2ch. Doubao IME was also observed with input active.
This verifies recovery of routing, not resolution of Bluetooth stuttering.

The source now resolves `MiRemoteV2ch_UID` again before resuming a paused engine,
explicitly selects its current device ID, and verifies both the selected ID and
UID before and after starting. It does not trust an old numeric ID after driver
reload. An atomic render gate outputs silence without consuming queued PCM until
post-start verification succeeds. Missing devices, binding/read-back errors, and
start failures stop the output and surface an error. A running graph or resumed
graph redirected elsewhere is stopped and rebuilt. Normal resume preserves the
graph and queued PCM. Core Audio property strings now release their owned CF
reference because identity verification also runs on the active enqueue path.

All three native audio/queue/battery tests and 16 Rust audio-service tests passed.
Regression cases cover changed IDs, running/resume redirection, startup silence,
preserved PCM, and missing-device/bind/read-back/start failures. A temporary native
probe using the production bridge also passed three real Core Audio cycles on this
Mac: pause its own empty graph, redirect that graph to the real default output,
resume, and verify it selects MiRemoteV while retaining the same engine. The probe
sent no audio, captured none, and did not alter the system default devices. It
does not reproduce actual driver reload or explain the original trigger.

The source change has not yet replaced the installed app; immediate recovery used
its existing restart operation. Bluetooth throughput remains a separate issue.

## Runtime evidence

- RC003 firmware 2671 negotiates ATVV 1.0, ADPCM 16 kHz, 120-byte frames.
  Each frame decodes to 240 samples / 15 ms. Sustained realtime delivery requires
  about 66.7 frames per second.
- Sessions 68–72 typically delivered 45–65 frames per second. The application
  output queue usually held less than 40 ms. Enqueue failures, output discards,
  rejected packets, and AUDIO_SYNC events were zero in these observed sessions.
- Moving the remote within 20–30 cm did not remove the reported delay.
- No post-stop packets were observed in these sessions. Accepting late packets
  and preserving the ADPCM decoder across STOP were defensive experiments, not
  evidence that the reported lost speech has been recovered. Both are shelved.
- macOS negotiated ATT MTU 247 and link data length 251; the connection interval
  was 15 ms with peripheral latency zero. A missing MTU/DLE negotiation is not
  supported by this evidence.

## Isolated measurements on the user's machine

Temporary native probes sent synthetic signals and retained only timing metrics,
not microphone recordings. Measurements cover software delivery, not headphone
acoustic output. The production-bridge probe ran against the experimental
background-queue version before shelving; it does not establish identical
scheduling under UI load for the restored main-queue version.

| Path | Observation |
| --- | --- |
| MiRemoteV output → MiRemoteV input | 22 seconds, 2,060 observations; per-second mean 10.75–10.79 ms, no growth |
| MiRemoteV output → QuickTime monitor process output | 22 seconds; per-second means about 190–209 ms, no growth to 1.8 seconds |
| Production AKMacAudioBridge enqueue → MiRemoteV input | After a 3-second warmup, all 19 synthetic markers arrived in 36–46.4 ms, no enqueue failures |

The QuickTime probe used a quiet amplitude ramp and a process-specific Core Audio
tap. Estimating timestamps from the ramp slope becomes noisy at larger amplitudes;
the per-second means, rather than individual extrema, are the useful evidence.
The first engine probe had extra detections during startup and was inconclusive;
the warmed-up run above had exactly 19 transmitted and 19 received markers.

## Experiments that did not establish a fix

- Moving Bluetooth, decode, and output scheduling to a dedicated serial queue did
  not resolve the physical symptom. The change and its main-thread independence
  test are shelved together.
- ATVV on-request mode with MIC_OPEN playback mode was accepted by the remote,
  but the user still heard about 1.8 seconds of delay. That mode and its HID
  start/stop integration were reverted; the remote again negotiated HTT (0x03).
- A temporary, runtime-only CoreBluetooth low-latency request changed the actual
  connection interval to 30 ms, not a shorter interval. It was not added to the
  application. Reconnection restored the original 15 ms interval, confirmed in
  bluetoothd at 20:51:02.640. No private connection API remains in project code.

## Remaining uncertainty

The observations point upstream of decoded PCM enqueue, toward the remote / BLE
delivery path. They do not establish whether the cause is firmware buffering,
radio retransmission, or host Bluetooth scheduling. There is no frame sequence
number in this remote's headerless audio notifications and no AUDIO_SYNC in the
observed sessions, so received-byte deficits alone cannot distinguish delayed
audio from discarded audio. Do not infer an exact remote buffer size from the
user's approximately 2-second estimate.

Further useful evidence would be a comparison with the same remote on another
host, or a Bluetooth controller trace with retransmission / connection-event
statistics. Increasing the local playback buffer or discarding local PCM is not
supported by the current evidence and risks making speech completeness worse.

## Shelved code and current baseline

At the user's request, all remaining uncommitted latency experiments and their
associated tests were removed from the working tree and preserved in a local
Git stash. This is not a released fix.

- Stash commit: `9919dfb790c4f64c91e2ff4fe92e5d0062d59643`
- Stash message: `wip: RC003 cumulative latency experiments (unresolved, 2026-09-16)`
- Files: `src-tauri/native/macos_audio.m`,
  `src-tauri/src/audio_service/macos.rs`, `test/macos-audio-tail-drain.m`,
  `test/macos-pcm-queue.c`.
- Contents: the dedicated worker and dispatch timers, 300 ms late-tail handling,
  decoder preservation across STOP, diagnostic additions, and associated tests.
- Inspect with `git stash show -p 9919dfb790c4f64c91e2ff4fe92e5d0062d59643`.
  Recover deliberately with `git stash apply 9919dfb790c4f64c91e2ff4fe92e5d0062d59643`;
  do not automatically restore these experiments when resuming unrelated work.

The previously committed fixes remain: `2451ca4` reuses the macOS audio output
engine, and `d22b0b0` renders through the real-time PCM ring. The user confirmed
that these resolved the original startup delay and persistent crackling. The
later cumulative-delay symptom remains open. The reverted on-request-mode
experiment and temporary private-API probes are not in the stash or active code;
their outcomes are recorded above.

After shelving, the restored code passed 16 Rust audio-service tests and 3 native
audio tests (including the PCM queue checks under AddressSanitizer and
UndefinedBehaviorSanitizer). The development app rebuilt and reconnected to the
remote. Only this investigation record and its architecture-document link remain
as working-tree changes; the code changes are in the stash.
