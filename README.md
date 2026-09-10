# Axonkey

Axonkey 是一款面向小米 RC003 蓝牙遥控器的本地控制台。macOS 版通过 IOKit 读取目标设备（`VID 0x2717` / `PID 0x32B8`）的原始 HID 报告，并用 CoreGraphics 与 AppKit 发送映射后的输入；Windows 版通过 Interception 过滤目标设备输入，并将 RC003 语音转发到 VB-CABLE。Windows 还提供默认关闭的 Frida 增强通道，用于读取返回和音量键。

项目目前专注于一个设备和一件事：让 RC003 成为可靠、易配置的快捷键控制器。Axonkey 不依赖 AutoHotkey、AutoHotInterception 或 Karabiner-Elements，配置和诊断数据均保存在本机。

## 当前平台状态

| 平台 | 按键输入 | 可配置按键 | RC003 语音 | 当前结论 |
| --- | --- | ---: | --- | --- |
| macOS 13+ | IOKit 原始 HID + CoreGraphics / AppKit | 13 | ATVV -> IMA ADPCM -> `MiRemoteV 2ch` | 支持按键映射与语音；需要输入监控与辅助功能权限 |
| Windows 11 x64 | Interception 1.0.1 + 可选 Frida 增强通道 | 13（其中 3 个需单独开启增强支持） | ATVV -> IMA ADPCM -> `CABLE Input`，应用从 `CABLE Output` 收音 | 基础映射需要 Interception；返回与音量键增强默认关闭，需管理员授权；语音另需 VB-CABLE |

## 界面截图


<p align="center">
  <img src="./docs/images/axonkey-home.png" width="960" alt="Axonkey 主页，显示 RC003 状态、系统权限、语音通道和快捷操作">
</p>
<p align="center"><sub>主页状态总览：设备、权限、语音通道与快捷操作</sub></p>

<p align="center">
  <img src="./docs/images/axonkey-mapping.png" width="960" alt="Axonkey 按键映射界面，显示 RC003、触发方式和行为编辑器">
</p>
<p align="center"><sub>按键映射：选择实体按键，再分别编辑单击、双击和长按行为</sub></p>

## 主要功能

- 主页集中显示输入环境、辅助功能、语音通道、RC003 连接状态和电量，并提供对应的处理入口。
- 识别 RC003 的连接状态与输入后端状态；Windows 和 macOS 版同时读取电量。
- 为每个可识别按键分别配置单击、双击和长按行为。
- Windows 的返回与音量键增强位于“按键映射 → 高级选项”，默认关闭，由用户阅读兼容性说明后自行选择。
- 直接选择常用行为，包括保留原按键、禁用、导航编辑和媒体控制。
- 支持单个按键、键盘录入、组合键和单独修饰键；macOS 界面会按系统习惯显示 Command 与 Option。
- 支持按顺序执行多个步骤，例如粘贴文本、等待和按下 Enter。
- 内置“输入文本并回车”行为：粘贴文本 -> 等待 30 ms -> Enter。
- 支持将完整映射导出为 JSON、重新导入或恢复默认映射。
- Windows 和 macOS 均可调节 RC003 语音输入增益（`-30 dB` 至 `+30 dB`）；Windows 输出到 `CABLE Input`，macOS 输出到 `MiRemoteV 2ch`。
- 修改后自动保存并立即应用，无需为普通映射变更重启应用或系统。
- 基础输入通道按 VID/PID 匹配 RC003；Windows 可选增强通道的共享宿主识别限制见下文。
- Windows 首次引导可安装并检查 Interception 与 VB-Audio VB-CABLE；macOS 引导可完成系统权限、安装 MiRemoteV 2ch 虚拟麦克风并连接设备。
- macOS 授权时提供置顶小窗，可直接打开对应设置、在 Finder 中定位当前 `Axonkey.app` 并重新检测权限。
- 关闭主窗口后继续常驻 Windows 系统托盘或 macOS 菜单栏，可从托盘菜单重新显示或完全退出。

## 支持范围与限制

当前只支持小米 RC003 蓝牙遥控器。macOS 可以配置全部 13 个已识别实体按键：语音、电源、四向、确认、返回、音量 `+ / -`、主页、菜单和 TV 键。返回键默认保持 Delete（退格）行为，音量键默认保持 macOS 系统音量行为与连续按压节奏，也可以改成其他单击、双击或长按映射。

Windows 编辑器提供 13 个按键，其中返回和独立音量 `+ / -` 需要开启可选增强支持，其余 10 个使用 Interception。增强支持默认关闭，不属于首次使用的必做步骤；开启方式见下方“可选：返回与音量键增强”。

增强通道会自动匹配当前 RC003 宿主中的按键报告流。如果其他蓝牙设备共用该宿主，且先发送相同格式和 usage 的报告，仍可能误匹配，不能保证这类设备之间的硬件隔离。技术依据和限制见 [Windows 输入](./docs/WINDOWS_INPUT.md)。

以下功能不在项目支持范围内：

- 其他遥控器或普通键盘型号；
- Linux；
- 云端账号、配置同步或遥测；
- 任意脚本、应用专属配置或通用自动化编辑器。

## 默认映射

| RC003 按键 | 单击行为 |
| --- | --- |
| 语音键 | 右 Alt（`RAlt`，macOS 界面显示为右 Option） |
| 电源键 | Escape（`Esc`） |
| 其他可配置按键 | 保留原按键 |

## 系统要求

### Windows

- 64 位 Windows 11；
- 已通过 Windows 蓝牙设置配对的 RC003；
- Interception v1.0.1 输入驱动；
- 需要虚拟麦克风时安装 VB-Audio VB-CABLE Pack45；
- 首次安装或卸载上述驱动时需要管理员权限，并需要重启 Windows 一次。
- 可选的返回与音量键增强需要为采集辅助进程授予管理员权限；未开启时不会启动该辅助进程或发起 Frida 注入。

Axonkey 使用 x64 `interception.dll`，因此不支持 32 位 Windows。输入服务按硬件 ID 只为 RC003 设置过滤条件。

### macOS

- macOS 13 Ventura 或更高版本，支持 Apple Silicon 与 Intel；
- 已通过系统蓝牙设置配对的 RC003；
- 在“隐私与安全性”中授予 Axonkey“输入监控”和“辅助功能”权限。
- 使用 RC003 麦克风时安装 Axonkey 提供的 `MiRemoteV 2ch` 虚拟音频驱动；安装或卸载需要管理员权限，不需要重启系统。

macOS 按键映射不需要安装输入驱动。未启用自定义映射，或两项权限尚未同时授予时，Axonkey 只做非独占设备监听，不会吞掉遥控器原始按键。启用映射且权限就绪后，应用会优先独占匹配的 RC003 HID 设备；如果系统不允许独占，则继续监听 HID 报告，并通过事件过滤器只拦截对应的 RC003 原始按键，再发送映射后的输入。

语音转发是独立链路：Axonkey 通过 CoreBluetooth 连接 RC003 的 ATVV 语音服务，将 16 kHz IMA ADPCM 解码为 PCM，再写入 `MiRemoteV 2ch` 的输出端；豆包输入法等应用选择同名输入端即可收音。音频引擎只在语音会话期间运行，退出 Axonkey 后不会继续转发。

## Windows 首次使用

1. 在 Windows 蓝牙设置中配对并唤醒 RC003。
2. 启动 Axonkey，按照首次使用引导检查设备和驱动。
3. 在“驱动安装”页面安装 Interception；需要语音时同时安装 VB-CABLE。完成所需驱动安装后重启 Windows 一次。
4. 重新打开 Axonkey，选择遥控器按键及触发方式，然后设置目标行为。
5. 打开“启用自定义按键功能”开关。

Interception 和 VB-CABLE 只需安装一次。之后添加、删除或修改映射不需要再次重启。

从源码目录或解压后的发行目录也可以手动运行安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-driver.ps1
```

脚本会校验随项目提供的 Interception 安装程序和运行库，说明系统变更，要求输入 `INSTALL` 确认，然后申请管理员权限。

也可以手动启动仓库中经过校验的 VB-CABLE 安装流程：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\vbcable-driver.ps1 -Action install
```

该脚本校验未修改的官方 Pack45 ZIP、x64 安装器哈希和发布者签名，随后申请管理员权限并打开 VB-Audio 官方安装窗口。安装完成后需要重启 Windows，录音设备列表中会出现 `CABLE Output (VB-Audio Virtual Cable)`。

Windows 语音链路由 Axonkey 直接维护：应用通过 Bluetooth GATT 连接 RC003 的 ATVV 服务，解码 16 kHz IMA ADPCM 音频并写入 `CABLE Input` 播放端点；录音应用选择 `CABLE Output (VB-Audio Virtual Cable)` 作为麦克风。按住语音键时才会建立或恢复语音会话，主页的增益滑杆（`-30 dB` 至 `+30 dB`）只作用于这一路音频。

> **Windows 音频设置提醒：** 微信输入法语音输入可能压低其他媒体音量，甚至中断播放。麦克风请选择 `CABLE Output`；系统和应用的扬声器输出请保留真实扬声器或耳机，不要选择 `CABLE Input` 等虚拟设备。Axonkey 会自行向 `CABLE Input` 写入遥控器语音，无需将其设为系统默认播放设备。

### 可选：返回与音量键增强

此功能默认关闭，入口位于“按键映射”页面底部收起的“高级选项”，不会出现在主页顶部。未开启时，返回、音量加和音量减会标注“需开启增强”；选中后显示“映射尚未生效”，点击“查看说明并开启”可直达该入口。默认的加减音量也需要增强支持，仅保存 `VolumeUp` / `VolumeDown` 映射不会启用采集。

**开启前请了解：** 此功能通过 Frida 向 Windows 蓝牙设备宿主进程注入 DLL，无法保证与游戏反作弊兼容；有顾虑请保持关闭。这个开关只控制增强采集通道，不控制 Interception 驱动，也不代表整个软件已通过游戏反作弊兼容性认证。

1. 连接 RC003，完成 Interception 设置，并打开“启用自定义按键功能”。
2. 展开“高级选项”，阅读“返回与音量键增强”的说明，自行决定是否点击“开启并授权”或打开“启用增强支持”开关。
3. Windows 弹出管理员授权时选择“是”。应用主体保持普通权限，仅采集辅助进程提权。
4. 状态显示“已启用”后，三个按键直接执行已保存的单击、双击或长按映射，首次按键即可使用，无需测试或校准。

明确开启后会记住选择。保持增强支持与自定义按键功能都开启时，下次启动应用会自动请求一次管理员授权；取消后本次运行不会反复弹窗，可回到高级选项点击“管理员授权”重试。旧版保存的开启状态不会自动沿用，需要在阅读新增说明后重新选择。安装包已携带 Frida DLL，无需安装 Python 或为这条通道安装新的驱动。

关闭开关会停止采集并释放已按下的映射输出，但已加载的 DLL 可能仍驻留在 Windows 宿主进程中。**如需清除已加载的 DLL，请保持该功能关闭并重启 Windows。** 关闭应用主窗口只会隐藏到托盘，不等于停止采集。

实现与故障排查见 [Windows 输入](./docs/WINDOWS_INPUT.md)，组件版本、校验值与许可见 [Frida 来源说明](./vendor/frida/SOURCE.md)。

## macOS 首次使用

1. 打开 DMG，将 `Axonkey.app` 拖入“应用程序”，再从“应用程序”启动它。不要长期直接运行 DMG 中的副本，否则后续授权可能指向临时挂载路径。
2. 在 macOS 蓝牙设置中配对 RC003，并按任意键将遥控器唤醒。
3. 在“权限与音频”中先点击“输入监控”的“开始授权”，Axonkey 会打开“隐私与安全性”中的对应列表，并缩成屏幕右上角的置顶授权小窗。
4. 如果系统列表中没有 Axonkey，点击小窗中的“在 Finder 中显示”，将高亮的 `Axonkey.app` 拖入授权列表并打开开关；随后以相同方式完成“辅助功能”。小窗与主界面会自动重新检测权限，也可以手动点击“重新检测”。
5. 需要语音时点击“安装驱动”，完成管理员授权后确认界面显示 `MiRemoteV 2ch` 已安装；在豆包输入法中也选择 `MiRemoteV 2ch` 作为麦克风。
6. 返回完整窗口，确认 RC003 已连接，配置目标行为并打开“启用自定义按键功能”。

输入监控用于读取 RC003 的原始 HID 报告，辅助功能用于过滤原始系统事件并发送映射后的按键、快捷键或文本。权限跟应用的代码签名身份关联：频繁安装不同 ad-hoc 本地构建时，如果界面仍显示“待授权”，请在系统设置中移除旧 Axonkey 条目，再通过 Finder 重新添加当前 `Axonkey.app`；如果系统明确要求退出并重新打开应用，请按提示操作。

点击窗口左上角关闭按钮只会隐藏主窗口，Axonkey 仍常驻 macOS 菜单栏并继续处理映射。从菜单栏图标选择“显示 Axonkey”可恢复窗口；关闭“自定义按键功能”或选择“退出 Axonkey”才会释放 HID 捕获和事件过滤，让遥控器恢复由 macOS 直接处理。

### macOS 自签名版本的信任与限制

部分 GitHub Actions 或本地构建使用 Axonkey 的自签名证书，而不是 Apple Developer ID。此类版本不会通过 Apple 公证，首次启动时可能显示“无法验证开发者”“开发者无法验证”或“应用已损坏”；随应用提供的 `MiRemoteV 2ch` 安装包也可能出现类似提示。自签名只解决代码身份在不同版本之间保持稳定的问题，不会让 macOS 自动信任下载来源，也不等同于输入监控或辅助功能授权。

首次启动被拦截时：

1. 先将 DMG 中的 `Axonkey.app` 拖到“应用程序”，不要长期直接运行 DMG 内的副本。
2. 在 Finder 的“应用程序”中按住 Control 点击 `Axonkey.app`，选择“打开”，再在确认对话框中点击“打开”。这是 macOS 对该自签名应用建立本机例外的方式。
3. 如果没有出现“打开”按钮，打开“系统设置 -> 隐私与安全性”，滚动到“安全性”区域，点击“仍要打开”，然后重新启动 Axonkey。
4. 安装 `MiRemoteV 2ch` 时若安装器被拦截，也在 Finder 中对对应 PKG 选择“打开”；只有在确认文件来自本项目且校验和匹配 Release 页面时才执行此操作。

应用能够启动后，仍需在“隐私与安全性 -> 输入监控”和“隐私与安全性 -> 辅助功能”中分别添加当前“应用程序/Axonkey.app”并打开开关。若升级后界面再次显示“需要重新授权”，先移除列表中的旧 Axonkey，再通过 Finder 重新添加当前版本；证书信任不能替代这两项 TCC 权限。自签名证书丢失或被重新生成后，macOS 也会将后续构建视为新的应用身份，因此发布者必须长期保留同一套证书和私钥。

## 卸载输入驱动

先退出 Axonkey 和其他使用 Interception 的工具，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-driver.ps1
```

脚本要求输入 `UNINSTALL` 并申请管理员权限。卸载完成后需要重启 Windows。

## 本地开发

开发环境需要 Node.js 与 Rust stable。Windows 还需要 MSVC 构建工具和 WebView2；macOS 开发应用需要 Xcode Command Line Tools，构建 MiRemoteV 驱动和发布包需要完整 Xcode。macOS/Linux shell 中安装依赖并启动 Tauri 桌面应用：

```bash
cp .env.example .env
npm install
npm run tauri dev
```

Windows PowerShell 使用 `Copy-Item .env.example .env` 创建本地版本文件，其余命令相同。

`.env` 是本机版本来源并被 Git 忽略，只允许包含一行 `version=vX.Y.Z`。首次检出时从已提交的 `.env.example` 复制；`make release` 会同时更新本地 `.env`、`.env.example` 和各框架清单中的版本。

检查前端生产构建和 Rust 测试：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

项目也提供 Makefile：

```bash
make dev
make build
make build-macos-audio
make build-macos
make test-release
make release
make release V=v0.1.25
```

`.env` 不纳入 Git，且只包含一行 `version=vX.Y.Z`。`make build` 只校验 `.env` 与 npm、Cargo、Tauri
版本一致，然后根据当前平台构建安装包，不修改版本文件或 Git 状态。Windows 生成 NSIS 安装程序，macOS 生成 DMG：

```text
Windows: src-tauri\target\release\bundle\nsis\Axonkey_<version>_x64-setup.exe
macOS:   src-tauri/target/release/bundle/dmg/Axonkey_<version>_<arch>.dmg
```

`make build-macos` 使用同一版本校验，并生成当前架构的 `.app` 与 `.dmg`：

```text
src-tauri/target/release/bundle/macos/Axonkey.app
src-tauri/target/release/bundle/dmg/Axonkey_<version>_<arch>.dmg
```

`make build-macos-audio` 可单独从固定的 BlackHole 源码构建 MiRemoteV 驱动及安装、卸载 PKG；`make build` 和 `make build-macos` 在 macOS 上会自动执行这一步。

设置 `APPLE_SIGNING_IDENTITY` 后，`make build-macos` 会用该证书签名 App 和 DMG；此时还需通过 `MACOS_INSTALLER_SIGNING_IDENTITY` 指定钥匙串中的安装包签名证书，否则构建会拒绝嵌入未签名的 MiRemoteV PKG。构建流程支持自签名证书和 Developer ID 证书。两项 identity 都不设置时，App 使用 ad-hoc 签名，MiRemoteV PKG 不签名。输入监控和辅助功能权限绑定代码签名身份，经常安装本地构建时应固定使用同一签名证书。ad-hoc 构建每次变化后都可能需要移除旧权限条目并重新授权。

自签名分发包的首次安装与授权步骤见上方“macOS 自签名版本的信任与限制”。使用 Developer ID 签名并配置 Apple 公证凭据时，CI 会执行公证流程。

`make release` 要求 Git 工作区完全干净。未传 `V` 时，它从 `.env` 递增 patch；也可以用 `V=vX.Y.Z` 指定版本。命令会同步 `.env.example`、npm、Cargo 和 Tauri 版本，创建 `chore: release vX.Y.Z` 提交，再在该提交上创建 annotated tag。它不会构建、推送或发布远端 Release。

## 工作原理

```text
Windows input: RC003 -> Interception -> 扫描码 -> 行为状态机 -> 同设备发送
Windows voice: RC003 -> Bluetooth GATT ATVV -> IMA ADPCM -> PCM -> CABLE Input -> CABLE Output
macOS input:   RC003 -> IOHIDManager -> HID usage -> 行为状态机 -> CoreGraphics / AppKit 发送
macOS voice:   RC003 -> CoreBluetooth ATVV -> IMA ADPCM -> PCM -> MiRemoteV 2ch
```

输入服务只为识别出的 RC003 设备设置过滤条件。设置更新采用本地快照，界面保存后会直接替换输入服务中的当前配置。

更多实现信息见 [架构说明](./docs/ARCHITECTURE.md)、[产品范围](./docs/PRODUCT.md) 和 [Windows 输入说明](./docs/WINDOWS_INPUT.md)。

## 运行日志

Axonkey 会在本地记录启动、设备连接、输入/音频服务、系统探测和命令失败等运行时信息，不会上传日志，也不会记录映射文本内容。主页“运行日志”按钮可以直接打开日志目录，将 `axonkey.log` 和需要的滚动旧日志一起发送即可。

日志按文件大小滚动：单个文件达到 5 MB 后自动切换，并保留最近 5 个旧文件。Tauri 默认日志目录为：Windows 的 `%LOCALAPPDATA%\com.axonkey.app\logs`，macOS 的 `~/Library/Logs/com.axonkey.app`。驱动安装器仍会把单独的安装输出写入下方的 `Axonkey\logs` 目录。

Windows 音频链路常驻 INFO 级诊断，不需要开启调试模式。连接时记录协商的协议、编码、帧大小和 CABLE 输出格式；语音活动期间约每秒输出一条 `RC003 audio diagnostics`，短会话会汇入下一个统计窗口，连接关闭时补记剩余统计。空闲且没有音频数据或控制事件时不刷日志，不保存音频包内容、PCM 或识别文本。

- `window_ms` 为实际统计窗口长度，各计数是窗口增量，不是会话总量；跨线程计数是近似快照。`starts/stops/syncs` 统计收到的控制事件，不表示音频已经成功输出。
- `rx_packets/rx_bytes/last_rx_ms` 表示收到的音频通知数量、字节数和距最后一包的毫秒数（`never` 表示服务启动以来尚未收包）；`rejected_packets` 是因空包、未就绪或停止保护窗口等原因未进入解码的包数，`notification_read_errors` 是读取音频或控制通知失败的次数。
- `decoded_samples/pcm_peak/pcm_rms` 表示解码后的单声道样本数、峰值和 RMS（增益前的 i16 幅度，绝对满幅为 32768）。持续收包但这些电平接近零，说明解码后的信号近乎静音，不能单凭此项认定硬件故障。
- `output_callbacks/consumed_samples` 表示播放回调次数和从队列取出的 16 kHz 源样本数，不保证下游录音应用已收到声音。`unfilled_output_frames` 是因没有足够样本等原因填零的输出帧数（按输出采样率计，不等于内容本身静音）；`queue_busy_callbacks` 是未取得队列锁的回调数，`overflow_samples` 是队列溢出丢弃的源样本数。会话边缘和空闲窗口的填零是正常现象。
- `streaming/microphone_opened/session_id/queued_samples/gain_db` 提供控制状态、队列余量和增益上下文。排查只有按下瞬间有电平时，保持按住语音键连续说话约 10 秒，再提供包含开始、周期统计和停止事件的日志。

macOS 同样常驻 INFO 级诊断，使用 `macOS RC003 audio diagnostics` 标识，共用收包、拒收、通知读取错误、增益前 PCM 电平和控制事件统计。每秒汇总，空闲不写日志，暂停或停止服务时补记并取消定时器；不保存语音内容。状态变化、协议协商、输出格式和语音命令提交也会进入运行日志。

- macOS 输出采用 AVAudioPlayerNode 缓冲调度，不使用 Windows 的输出回调/欠载字段。`scheduled_samples` 是成功排入播放器的源样本数，`enqueue_failures` 是排入失败的缓冲次数；`completed_buffers/played_samples` 仅在当前播放器返回 `DataPlayedBack` 完成回调后累加，不能据此证明下游输入法已收音。
- `pending_buffers/engine_running/player_playing/drain_requested` 表示待完成缓冲数、引擎/播放器状态和尾音排空状态；`discarded_pending_buffers` 是输出重置时仍未确认完成的缓冲数量，不等于丢弃样本数。播放完成计数在主线程处理回调时记录，跨统计窗口延迟是正常现象。

## 隐私与恢复

- Axonkey 不需要账号，不上传映射、输入历史或诊断信息。
- 映射配置保存在本机应用数据中。
- Windows 驱动安装和卸载日志位于 `%LOCALAPPDATA%\Axonkey\logs`。
- macOS MiRemoteV 安装和卸载日志位于 `~/Library/Logs/Axonkey`。
- Windows 中退出 Axonkey 会释放用户态 Interception context，停止处理自定义映射。
- macOS 中关闭主窗口不会退出应用；关闭自定义映射或从菜单栏选择“退出 Axonkey”后，HID 捕获与事件过滤才会停止。

### Windows 断连后按键无响应

Interception 存在设备断开后重新连接可能无法输入的已知问题：RC003 在 Windows 中仍显示已连接，但按键没有响应，退出或重启 Axonkey 也可能无法恢复。原始报告见 [Interception issue #25](https://github.com/oblitum/Interception/issues/25)。

问题涉及驱动对重新枚举设备的处理。上游 [issue #193](https://github.com/oblitum/Interception/issues/193) 将其归因于固定设备编号范围：反复断连、重连可能生成超出驱动支持范围的设备编号，即使是同一台设备也可能触发。Axonkey 只过滤 RC003 的用户态逻辑无法修复该内核驱动状态；这也不意味着每次重连都会失败。

遇到该现象时，重启电脑即可。详细现象、原因和既有排查证据见 [Interception 重连问题说明](./docs/INTERCEPTION_HOTPLUG_INCIDENT.md)。

## Interception 许可

Interception 是独立的第三方组件，并采用双重许可。其上游许可允许在所列 LGPL 条款下进行非商业使用；商业分发需要向 Interception 作者取得单独授权。在取得相应许可前，请勿将包含 Interception 资源的 Axonkey 用于商业分发。

具体版本、文件哈希、许可文本和上游链接见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [vendor/interception/SOURCE.md](./vendor/interception/SOURCE.md)。

## VB-CABLE 许可

VB-CABLE 是 VB-Audio Software 提供的 Donationware。Axonkey 原样携带官方 Pack45 ZIP，并在引导中明确展示其来源；如果你认为 VB-CABLE 有用或将其用于专业场景，请通过 [VB-Audio 官方页面](https://vb-audio.com/Cable/) 捐赠或购买许可。

版本、哈希和分发说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [vendor/vbcable/SOURCE.md](./vendor/vbcable/SOURCE.md)。

## MiRemoteV 2ch 许可

`MiRemoteV2ch.driver` 由 Axonkey 从固定的 BlackHole v0.7.1 源码和仓库内补丁构建，采用 GPL-3.0。构建配方、对应源码提交和修改说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [third_party/blackhole/README.md](./third_party/blackhole/README.md)。

## 相关项目

Axonkey 的产品灵感来自 [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app)。macOS 原生后端参考了该项目经真机验证的 RC003 VID/PID、HID usage、ATVV 语音协议、IOKit 权限检查、CoreGraphics 键盘注入和 Core Audio 输出路径；Axonkey 仍维护独立的 Tauri 界面、设置格式、驱动构建和运行时服务。

Axonkey 与 remote-mic-app 是相互独立的项目，本仓库不是其 fork。
