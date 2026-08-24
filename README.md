# Axonkey

<p align="center">
  <img src="./public/rc003-remote.png" width="180" alt="小米 RC003 蓝牙遥控器">
</p>

Axonkey 是一款面向小米 RC003 蓝牙遥控器的 Windows 本地按键映射工具。它通过 Interception 驱动识别指定的物理设备（`VID 0x2717` / `PID 0x32B8`），把遥控器按键转换为键盘按键、组合键或连续行为，同时避免普通键盘进入映射处理流程。

项目目前专注于一个设备和一件事：让 RC003 在 Windows 上成为可靠、易配置的快捷键控制器。Axonkey 不依赖 AutoHotkey 或 AutoHotInterception，配置和诊断数据均保存在本机。

> **已确认的驱动阻断问题：** Interception 1.0.1 无法可靠处理 RC003 的蓝牙 HID 断开重连。故障发生后，Windows 仍可显示设备正常，但所有按键都没有输入；退出 Axonkey 也无法恢复。当前输入架构不应视为可发布的稳定方案。完整证据、恢复步骤和替代要求见 [Interception 热插拔故障记录](./docs/INTERCEPTION_HOTPLUG_INCIDENT.md)。

## 主要功能

- 识别 RC003 的连接状态、电量和输入驱动状态。
- 为每个可识别按键分别配置单击、双击和长按行为。
- 直接选择常用行为，包括保留原按键、禁用、导航编辑和媒体控制。
- 支持单个按键、键盘录入、组合键，以及左/右 Alt 等单独修饰键。
- 支持按顺序执行多个步骤，例如粘贴文本、等待和按下 Enter。
- 内置“输入文本并回车”行为：粘贴文本 -> 等待 30 ms -> Enter。
- 修改后自动保存并立即应用，无需为普通映射变更重启 Windows。
- 只处理匹配 VID/PID 的目标设备，不修改普通键盘的按键行为。
- 首次使用引导可安装并检查 VB-Audio VB-CABLE 虚拟麦克风驱动。

## 支持范围与限制

当前只支持小米 RC003 蓝牙遥控器。可配置的实体按键包括语音、电源、方向、确认、主页、菜单和 TV 键。

返回键和遥控器上的独立音量 `+ / -` 键暂时不能作为映射触发键。Windows 无法可靠区分这些按键事件来自哪台输入设备，Axonkey 因而不能确认事件来自 RC003；强制拦截可能影响普通键盘或其他遥控器。其他可识别按键仍然可以映射为系统音量增大、减小或静音。

当前版本不计划支持：

- 其他遥控器或普通键盘型号；
- Linux；macOS 可以生成 DMG，但 RC003 输入拦截和驱动管理功能仍仅支持 Windows；
- 云端账号、配置同步或遥测；
- 任意脚本、应用专属配置或通用自动化编辑器。

## 默认映射

| RC003 按键 | 单击行为 |
| --- | --- |
| 语音键 | 右 Alt（`RAlt`） |
| 电源键 | Escape（`Esc`） |
| 方向、确认、主页、菜单和 TV 键 | 保留原按键 |

## 系统要求

- 64 位 Windows 10 或 Windows 11；
- 已通过 Windows 蓝牙设置配对的 RC003；
- Interception v1.0.1 输入驱动；
- 需要虚拟麦克风时安装 VB-Audio VB-CABLE Pack45；
- 首次安装或卸载上述驱动时需要管理员权限，并需要重启 Windows 一次。

Axonkey 使用 x64 Interception 运行库，因此不支持 32 位 Windows。

Interception 当前仅保留为已有实现依赖，不代表推荐安装。RC003 会周期性重建蓝牙 HID 键盘节点，该驱动存在已确认的热插拔故障，可能让遥控器在重连后彻底失去输入，直到卸载驱动并重启。

## 首次使用

> 在替代输入驱动完成前，以下 Interception 安装步骤仅用于隔离测试环境。日常使用的 Windows 系统应跳过输入驱动安装；此时 Axonkey 的自定义按键映射不可用，但不会引入已确认的重连失效风险。

1. 在 Windows 蓝牙设置中配对并唤醒 RC003。
2. 启动 Axonkey，按照首次使用引导检查设备和驱动。
3. 仅在隔离测试环境中，在“驱动安装”页面依次安装 Interception 和 VB-CABLE；两个安装器都完成后重启 Windows 一次。
4. 重新打开 Axonkey，选择遥控器按键及触发方式，然后设置目标行为。
5. 打开“启用自定义按键功能”开关。

VB-CABLE 只需安装一次。Interception 安装说明仅保留用于复现和迁移验证，不应作为当前生产安装建议。之后添加、删除或修改映射不需要再次重启。

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

## 卸载输入驱动

先退出 Axonkey 和其他使用 Interception 的工具，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-driver.ps1
```

脚本要求输入 `UNINSTALL` 并申请管理员权限。卸载完成后需要重启 Windows。

## 本地开发

开发环境需要 Node.js、Rust stable、Windows MSVC 构建工具和 WebView2。安装依赖并启动 Tauri 桌面应用：

```powershell
Copy-Item .env.example .env
npm install
npm run tauri dev
```

检查前端生产构建和 Rust 测试：

```powershell
npm run build
cargo test --manifest-path .\src-tauri\Cargo.toml
```

项目也提供 Makefile：

```powershell
make dev
make build
make release
make release V=v0.2.6
```

`.env` 不纳入 Git，且只包含一行 `version=vX.Y.Z`。`make build` 只校验 `.env` 与 npm、Cargo、Tauri
版本一致，然后根据当前平台构建安装包，不修改版本文件或 Git 状态。Windows 生成 NSIS 安装程序，macOS 生成 DMG：

```text
Windows: src-tauri\target\release\bundle\nsis\Axonkey_<version>_x64-setup.exe
macOS:   src-tauri/target/release/bundle/dmg/Axonkey_<version>_<arch>.dmg
```

`make release` 要求 Git 工作区干净；默认从 `.env` 读取当前版本并递增 patch，也可以通过
`V=vX.Y.Z` 指定版本。它会同步 `.env.example`、npm、Cargo 和 Tauri 版本，创建发布提交和带注释的
Git 标签，但不会构建或推送。

## GitHub Tag 自动构建

向 GitHub 推送指向 `main` 分支历史的版本 Tag 会自动构建 Windows 安装包。Tag 必须采用
`vMAJOR.MINOR.PATCH` 格式，例如 `v0.2.6`；去掉开头 `v` 后的值会在构建时同步为所有应用清单中的版本号。

```powershell
git checkout main
make release V=v0.2.6
git push origin main
git push origin v0.2.6
```

构建完成后，工作流会创建对应的 GitHub Release，并上传带版本号的 NSIS 安装程序及其 SHA-256
校验文件；同样的文件也会作为 GitHub Actions Artifact 保留。如果 Tag 指向的提交不属于 `main`
历史，工作流会拒绝构建。目标分支可通过工作流中的 `RELEASE_BRANCH` 修改。

## 工作原理

```text
RC003 HID 键盘
  -> Interception 键盘过滤驱动
  -> 按 VID/PID 选择目标设备
  -> 解析扫描码和触发方式
  -> 执行原按键、禁用、替换按键或连续行为
  -> 在同一 RC003 设备上发送结果
```

输入服务只为识别出的 RC003 设备设置过滤条件。设置更新采用本地快照，界面保存后会直接替换输入服务中的当前配置。

更多实现信息见 [架构说明](./docs/ARCHITECTURE.md) 和 [产品范围](./docs/PRODUCT.md)。

## 隐私与恢复

- Axonkey 不需要账号，不上传映射、输入历史或诊断信息。
- 映射配置保存在本机应用数据中。
- 驱动安装和卸载日志位于 `%LOCALAPPDATA%\Axonkey\logs`。
- 退出 Axonkey 会释放用户态 Interception 上下文，但无法修复驱动热插拔故障。若 RC003 重连后完全没有输入，需要卸载 Interception、重启 Windows 并重新配对。

## Interception 许可

Interception 是独立的第三方组件，并采用双重许可。其上游许可允许在所列 LGPL 条款下进行非商业使用；商业分发需要向 Interception 作者取得单独授权。在取得相应许可前，请勿将包含 Interception 资源的 Axonkey 用于商业分发。

具体版本、文件哈希、许可文本和上游链接见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [vendor/interception/SOURCE.md](./vendor/interception/SOURCE.md)。

## VB-CABLE 许可

VB-CABLE 是 VB-Audio Software 提供的 Donationware。Axonkey 原样携带官方 Pack45 ZIP，并在引导中明确展示其来源；如果你认为 VB-CABLE 有用或将其用于专业场景，请通过 [VB-Audio 官方页面](https://vb-audio.com/Cable/) 捐赠或购买许可。

版本、哈希和分发说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [vendor/vbcable/SOURCE.md](./vendor/vbcable/SOURCE.md)。

## 相关项目

Axonkey 的产品灵感来自 [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app)。该项目在 macOS 上将小米蓝牙遥控器扩展为无线麦和快捷操作设备；Axonkey 借鉴了这一思路，并针对 Windows 输入链路独立实现了 RC003 按键映射版本。

Axonkey 与 remote-mic-app 是相互独立的项目，本仓库不是其 fork。
