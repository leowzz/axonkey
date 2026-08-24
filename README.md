# Axonkey

<p align="center">
  <img src="./public/rc003-remote.png" width="180" alt="小米 RC003 蓝牙遥控器">
</p>

Axonkey 是一款面向小米 RC003 蓝牙遥控器的 Windows 与 macOS 本地按键映射工具。Windows 版通过 OpenInputBridge 驱动识别指定物理设备（`VID 0x2717` / `PID 0x32B8`）；macOS 版通过 IOKit 读取同一设备的原始 HID 报告，并用 CoreGraphics 与 AppKit 发送映射后的输入。两个平台的用户态映射都只处理目标遥控器，普通键盘不会进入映射流程。

项目目前专注于一个设备和一件事：让 RC003 成为可靠、易配置的快捷键控制器。Axonkey 不依赖 AutoHotkey、AutoHotInterception 或 Karabiner-Elements，配置和诊断数据均保存在本机。

> **Windows 迁移状态：** Axonkey 已移除运行时和安装包中的 Interception 依赖，改为直接使用 OpenInputBridge IOCTL，并强制校验 `OIB1` 驱动身份。Interception 的已确认断联故障与恢复步骤保留在[事故记录](./docs/INTERCEPTION_HOTPLUG_INCIDENT.md)。OpenInputBridge 的 RC003 循环重连验收仍需在 Windows 真机完成，在通过验收矩阵前不要把代码迁移等同于已证明修复。

## 主要功能

- 识别 RC003 的连接状态与输入后端状态；Windows 版同时读取电量。
- 为每个可识别按键分别配置单击、双击和长按行为。
- 直接选择常用行为，包括保留原按键、禁用、导航编辑和媒体控制。
- 支持单个按键、键盘录入、组合键和单独修饰键；macOS 界面会按系统习惯显示 Command 与 Option。
- 支持按顺序执行多个步骤，例如粘贴文本、等待和按下 Enter。
- 内置“输入文本并回车”行为：粘贴文本 -> 等待 30 ms -> Enter。
- 修改后自动保存并立即应用，无需为普通映射变更重启应用或系统。
- 只处理匹配 VID/PID 的目标设备，不修改普通键盘的按键行为。
- Windows 首次引导可安装并检查 OpenInputBridge 与 VB-Audio VB-CABLE；macOS 首次引导精简为系统权限和设备连接两步。
- macOS 授权时提供置顶小窗，可直接打开对应设置、在 Finder 中定位当前 `Axonkey.app` 并重新检测权限。
- 关闭主窗口后继续常驻 Windows 系统托盘或 macOS 菜单栏，可从托盘菜单重新显示或完全退出。

## 支持范围与限制

当前只支持小米 RC003 蓝牙遥控器。macOS 可以配置全部 13 个已识别实体按键：语音、电源、四向、确认、返回、音量 `+ / -`、主页、菜单和 TV 键。返回键默认保持 Delete（退格）行为，音量键默认保持 macOS 系统音量行为与连续按压节奏，也可以改成其他单击、双击或长按映射。

Windows 编辑器只开放其中 10 个按键，不提供返回键和独立音量 `+ / -` 作为映射触发键。Windows 无法可靠区分这些原始事件来自哪台输入设备，强制拦截可能影响其他键盘或遥控器。可配置按键仍然可以映射为系统音量增大、减小或静音。

当前版本不计划支持：

- 其他遥控器或普通键盘型号；
- Linux；macOS 可以生成 DMG，但 RC003 输入拦截和驱动管理功能仍仅支持 Windows；
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

- 64 位 Windows 11；Windows 10 仅保留待验证兼容性，不属于当前正式支持范围；
- 已通过 Windows 蓝牙设置配对的 RC003；
- OpenInputBridge 1.00 WHQL 键盘与鼠标驱动；
- 需要虚拟麦克风时安装 VB-Audio VB-CABLE Pack45；
- 首次安装或卸载上述驱动时需要管理员权限，并需要重启 Windows 一次。

Axonkey 只支持 x64 Windows。Windows 后端直接打开 OpenInputBridge 控制设备，不加载 `interception.dll`；启动时必须同时检测到 `OpenInputBridgeKeyboard` 和 `OpenInputBridgeMouse` 服务，并通过 OIB 专有身份 IOCTL，旧 Interception 不会被当作兼容后端继续使用。

### macOS

- macOS 13 Ventura 或更高版本，支持 Apple Silicon 与 Intel；
- 已通过系统蓝牙设置配对的 RC003；
- 在“隐私与安全性”中授予 Axonkey“输入监控”和“辅助功能”权限。

macOS 不需要安装输入驱动。未启用自定义映射，或两项权限尚未同时授予时，Axonkey 只做非独占设备监听，不会吞掉遥控器原始按键。启用映射且权限就绪后，应用会优先独占匹配的 RC003 HID 设备；如果系统不允许独占，则继续监听 HID 报告，并通过事件过滤器只拦截对应的 RC003 原始按键，再发送映射后的输入。

## Windows 首次使用

1. 如果系统安装过 Interception，先使用其官方 `install-interception.exe /uninstall` 移除并重启。Axonkey 的 OIB 安装脚本检测到旧 `keyboard.sys`/`mouse.sys` 时会拒绝继续，避免两个 class filter 混装。
2. 在 Windows 蓝牙设置中配对并唤醒 RC003。
3. 启动 Axonkey，在“驱动安装”页面安装 OpenInputBridge；需要虚拟麦克风时再安装 VB-CABLE，然后重启 Windows。
4. 重新打开 Axonkey，确认界面显示 OIB 后端工作正常，再配置行为并打开“启用自定义按键功能”。

OpenInputBridge 和 VB-CABLE 都只需安装一次。之后添加、删除或修改映射不需要再次重启。

从源码目录或解压后的发行目录也可以手动运行安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openinputbridge-driver.ps1 -Action Install
```

脚本要求完整的官方 WHQL 包，校验 Applet LLC 安装器签名、Microsoft WHQL catalog 签名和包结构，要求输入 `INSTALL` 确认后申请管理员权限。源码仓库不包含付费签名包；Windows 发布构建会在缺包时直接失败，所需目录结构见 [vendor/openinputbridge/SOURCE.md](./vendor/openinputbridge/SOURCE.md)。

也可以手动启动仓库中经过校验的 VB-CABLE 安装流程：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\vbcable-driver.ps1 -Action install
```

该脚本校验未修改的官方 Pack45 ZIP、x64 安装器哈希和发布者签名，随后申请管理员权限并打开 VB-Audio 官方安装窗口。安装完成后需要重启 Windows，录音设备列表中会出现 `CABLE Output (VB-Audio Virtual Cable)`。

## macOS 首次使用

1. 打开 DMG，将 `Axonkey.app` 拖入“应用程序”，再从“应用程序”启动它。不要长期直接运行 DMG 中的副本，否则后续授权可能指向临时挂载路径。
2. 在 macOS 蓝牙设置中配对 RC003，并按任意键将遥控器唤醒。
3. 首次引导只有“系统权限”和“连接设备”两步。先点击“输入监控”的“开始授权”，Axonkey 会打开“隐私与安全性”中的对应列表，并缩成屏幕右上角的置顶授权小窗。
4. 如果系统列表中没有 Axonkey，点击小窗中的“在 Finder 中显示”，将高亮的 `Axonkey.app` 拖入授权列表并打开开关；随后以相同方式完成“辅助功能”。小窗与主界面会自动重新检测权限，也可以手动点击“重新检测”。
5. 返回完整窗口，确认 RC003 已连接，配置目标行为并打开“启用自定义按键功能”。

输入监控用于读取 RC003 的原始 HID 报告，辅助功能用于过滤原始系统事件并发送映射后的按键、快捷键或文本。权限跟应用的代码签名身份关联：频繁安装不同 ad-hoc 本地构建时，如果界面仍显示“待授权”，请在系统设置中移除旧 Axonkey 条目，再通过 Finder 重新添加当前 `Axonkey.app`；如果系统明确要求退出并重新打开应用，请按提示操作。

点击窗口左上角关闭按钮只会隐藏主窗口，Axonkey 仍常驻 macOS 菜单栏并继续处理映射。从菜单栏图标选择“显示 Axonkey”可恢复窗口；关闭“自定义按键功能”或选择“退出 Axonkey”才会释放 HID 捕获和事件过滤，让遥控器恢复由 macOS 直接处理。

## 卸载输入驱动

先退出 Axonkey 和其他使用 OpenInputBridge 的工具，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\openinputbridge-driver.ps1 -Action Uninstall
```

脚本要求输入 `UNINSTALL` 并申请管理员权限。卸载完成后需要重启 Windows。

## 本地开发

开发环境需要 Node.js 与 Rust stable。Windows 还需要 MSVC 构建工具和 WebView2；macOS 需要 Xcode Command Line Tools。macOS/Linux shell 中安装依赖并启动 Tauri 桌面应用：

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
make build-macos
make test-release
make release
make release V=v0.2.6
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

设置 `APPLE_SIGNING_IDENTITY` 后，`make build-macos` 会用该证书签名 App 和 DMG；不设置时回退到 ad-hoc 签名。输入监控和辅助功能权限绑定代码签名身份，经常安装本地构建时应固定使用同一签名证书。ad-hoc 构建每次变化后都可能需要移除旧权限条目并重新授权。

面向外部用户分发时必须使用稳定的 Developer ID Application 身份并配置 Apple 公证凭据，不能把 ad-hoc CI 产物作为可延续系统权限的正式安装包。

`make release` 要求 Git 工作区完全干净。未传 `V` 时，它从 `.env` 递增 patch；也可以用 `V=vX.Y.Z` 指定版本。命令会同步 `.env.example`、npm、Cargo 和 Tauri 版本，创建 `chore: release vX.Y.Z` 提交，再在该提交上创建 annotated tag。它不会构建、推送或发布远端 Release。

## GitHub Tag 自动构建

先在 `main` 的干净工作区运行 `make release`，再推送 release commit 和 annotated tag：

```bash
git checkout main
make release V=v0.2.6
git push origin main --follow-tags
```

Tag 必须采用 `vMAJOR.MINOR.PATCH` 格式并指向 `main` 历史。GitHub Action 会从 `.env.example` 初始化 CI 的 `.env`，然后校验 Tag、`.env.example` 和所有已提交清单版本完全一致；CI 不会临时重写版本。

两个平台都构建成功且 SHA-256 校验通过后，工作流才会创建或更新对应的 GitHub Release，并上传
Windows NSIS、macOS Universal DMG 及各自的校验文件。相同文件也会作为 GitHub Actions Artifact
保留 30 天。如果 Tag 指向的提交不属于 `main` 历史，工作流会拒绝构建。目标分支可通过工作流中的
`RELEASE_BRANCH` 修改。

macOS Action 支持以下 Repository Secrets：

- Developer ID 签名：`APPLE_CERTIFICATE`（Base64 编码的 `.p12`）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`；
- Apple 公证：`APPLE_ID`、`APPLE_PASSWORD`（App 专用密码）、`APPLE_TEAM_ID`。

签名或公证凭据必须按组完整配置。六项全部配置时，工作流会先签名 App 和 DMG，再对移除隐藏卷图标后的最终 DMG 执行公证和 stapling。未配置时仍可生成 ad-hoc 签名的测试 DMG，但 GitHub Actions 会给出警告，该产物不适合作为正式外部分发包。

## 工作原理

```text
Windows: RC003 -> OpenInputBridge -> 扫描码 -> 行为状态机 -> OIB 写回
macOS:   RC003 -> IOHIDManager -> HID usage -> 行为状态机 -> CoreGraphics / AppKit 发送
```

输入服务只为识别出的 RC003 设备设置过滤条件。设置更新采用本地快照，界面保存后会直接替换输入服务中的当前配置。

更多实现信息见 [架构说明](./docs/ARCHITECTURE.md)、[产品范围](./docs/PRODUCT.md)、
[OpenInputBridge 迁移方案](./docs/OPENINPUTBRIDGE_MIGRATION_PLAN.md) 和
[Windows 交割文档](./docs/OPENINPUTBRIDGE_WINDOWS_HANDOFF.md)。

## 隐私与恢复

- Axonkey 不需要账号，不上传映射、输入历史或诊断信息。
- 映射配置保存在本机应用数据中。
- Windows 驱动安装和卸载日志位于 `%LOCALAPPDATA%\Axonkey\logs`。
- Windows 中禁用映射、目标消失或退出 Axonkey 时会关闭 OIB context；驱动按文件句柄清除过滤并恢复后续输入透传。若安装/升级后输入异常，先退出 Axonkey，再用官方安装器卸载 OIB 并重启。
- macOS 中关闭主窗口不会退出应用；关闭自定义映射或从菜单栏选择“退出 Axonkey”后，HID 捕获与事件过滤才会停止。

## OpenInputBridge 许可

OpenInputBridge 源码采用 MIT 许可，但其 WHQL 签名二进制是单独销售和授权的产品。Axonkey 取得明确的 OEM/再分发授权并记录签名包哈希前，不得生成对外发布的 Windows 安装包。来源、所需文件和待补授权信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [vendor/openinputbridge/SOURCE.md](./vendor/openinputbridge/SOURCE.md)。

## VB-CABLE 许可

VB-CABLE 是 VB-Audio Software 提供的 Donationware。Axonkey 原样携带官方 Pack45 ZIP，并在引导中明确展示其来源；如果你认为 VB-CABLE 有用或将其用于专业场景，请通过 [VB-Audio 官方页面](https://vb-audio.com/Cable/) 捐赠或购买许可。

版本、哈希和分发说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [vendor/vbcable/SOURCE.md](./vendor/vbcable/SOURCE.md)。

## 相关项目

Axonkey 的产品灵感来自 [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app)。macOS 原生后端参考了该项目经真机验证的 RC003 VID/PID、HID usage 报告格式、IOKit 权限检查和 CoreGraphics 键盘注入路径；Axonkey 仍维护独立的 Tauri 界面、设置格式与行为状态机。

Axonkey 与 remote-mic-app 是相互独立的项目，本仓库不是其 fork。
