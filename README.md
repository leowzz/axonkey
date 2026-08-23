# Axonkey

<p align="center">
  <img src="./public/rc003-remote.png" width="180" alt="小米 RC003 蓝牙遥控器">
</p>

Axonkey 是一款面向小米 RC003 蓝牙遥控器的 Windows 本地按键映射工具。它通过 Interception 驱动识别指定的物理设备（`VID 0x2717` / `PID 0x32B8`），把遥控器按键转换为键盘按键、组合键或连续行为，同时避免普通键盘进入映射处理流程。

项目目前专注于一个设备和一件事：让 RC003 在 Windows 上成为可靠、易配置的快捷键控制器。Axonkey 不依赖 AutoHotkey 或 AutoHotInterception，配置和诊断数据均保存在本机。

## 主要功能

- 识别 RC003 的连接状态、电量和输入驱动状态。
- 为每个可识别按键分别配置单击、双击和长按行为。
- 直接选择常用行为，包括保留原按键、禁用、导航编辑和媒体控制。
- 支持单个按键、键盘录入、组合键，以及左/右 Alt 等单独修饰键。
- 支持按顺序执行多个步骤，例如粘贴文本、等待和按下 Enter。
- 内置“输入文本并回车”行为：粘贴文本 -> 等待 30 ms -> Enter。
- 修改后自动保存并立即应用，无需为普通映射变更重启 Windows。
- 只处理匹配 VID/PID 的目标设备，不修改普通键盘的按键行为。

## 支持范围与限制

当前只支持小米 RC003 蓝牙遥控器。可配置的实体按键包括语音、电源、方向、确认、主页、菜单和 TV 键。

返回键和遥控器上的独立音量 `+ / -` 键暂时不能作为映射触发键。Windows 无法可靠区分这些按键事件来自哪台输入设备，Axonkey 因而不能确认事件来自 RC003；强制拦截可能影响普通键盘或其他遥控器。其他可识别按键仍然可以映射为系统音量增大、减小或静音。

当前版本不计划支持：

- 其他遥控器或普通键盘型号；
- macOS 或 Linux；
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
- 首次安装或卸载驱动时需要管理员权限，并需要重启 Windows 一次。

Axonkey 使用 x64 Interception 运行库，因此不支持 32 位 Windows。

## 首次使用

1. 在 Windows 蓝牙设置中配对并唤醒 RC003。
2. 启动 Axonkey，按照首次使用引导检查设备和驱动。
3. 安装 Interception 输入驱动。安装程序会请求管理员权限，完成后重启 Windows。
4. 重新打开 Axonkey，选择遥控器按键及触发方式，然后设置目标行为。
5. 打开“启用自定义按键功能”开关。

驱动只需安装一次。之后添加、删除或修改映射不需要再次重启。

从源码目录或解压后的发行目录也可以手动运行安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-driver.ps1
```

脚本会校验随项目提供的 Interception 安装程序和运行库，说明系统变更，要求输入 `INSTALL` 确认，然后申请管理员权限。

## 卸载输入驱动

先退出 Axonkey 和其他使用 Interception 的工具，再运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-driver.ps1
```

脚本要求输入 `UNINSTALL` 并申请管理员权限。卸载完成后需要重启 Windows。

## 本地开发

开发环境需要 Node.js、Rust stable、Windows MSVC 构建工具和 WebView2。安装依赖并启动 Tauri 桌面应用：

```powershell
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
make build V=0.2.6
```

`make build` 要求 Git 工作区干净。它会同步版本号、创建发布提交和带注释的 Git 标签，然后生成 NSIS 安装程序：

```text
src-tauri\target\release\bundle\nsis\Axonkey_<version>_x64-setup.exe
```

## GitHub Tag 自动构建

向 GitHub 推送指向 `main` 分支历史的版本 Tag 会自动构建 Windows 安装包。Tag 必须采用
`vMAJOR.MINOR.PATCH` 格式，例如 `v0.2.6`；去掉开头 `v` 后的值会在构建时同步为所有应用清单中的版本号。

```powershell
git checkout main
git tag -a v0.2.6 -m "Axonkey 0.2.6"
git push origin v0.2.6
```

构建完成后，可以从对应的 GitHub Actions 运行中下载带版本号的 NSIS 安装程序及其 SHA-256 校验文件。
如果 Tag 指向的提交不属于 `main` 历史，工作流会拒绝构建。目标分支可通过工作流中的
`RELEASE_BRANCH` 修改。

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
- 如果映射出现问题，退出 Axonkey 会释放 Interception 上下文，普通按键输入将恢复正常传递。

## Interception 许可

Interception 是独立的第三方组件，并采用双重许可。其上游许可允许在所列 LGPL 条款下进行非商业使用；商业分发需要向 Interception 作者取得单独授权。在取得相应许可前，请勿将包含 Interception 资源的 Axonkey 用于商业分发。

具体版本、文件哈希、许可文本和上游链接见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [vendor/interception/SOURCE.md](./vendor/interception/SOURCE.md)。

## 相关项目

Axonkey 的产品灵感来自 [HD838A/remote-mic-app](https://github.com/HD838A/remote-mic-app)。该项目在 macOS 上将小米蓝牙遥控器扩展为无线麦和快捷操作设备；Axonkey 借鉴了这一思路，并针对 Windows 输入链路独立实现了 RC003 按键映射版本。

Axonkey 与 remote-mic-app 是相互独立的项目，本仓库不是其 fork。
