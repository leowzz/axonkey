# Axonkey · Vibe Coding 快捷键与语音输入工具

把小米蓝牙遥控器 2 Pro（RC003）和鼠标变成 Vibe Coding（AI 编程）的快捷控制器。在 macOS 和 Windows 上，为 Cursor、Claude Code、OpenAI Codex 等工具配置快捷键、常用提示词和组合动作，也能将遥控器用作语音输入麦克风。

[![Release](https://img.shields.io/github/v/release/leowzz/axonkey?style=flat&color=blue)](https://github.com/leowzz/axonkey/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/leowzz/axonkey/build-tag.yml?style=flat&label=build)](https://github.com/leowzz/axonkey/actions/workflows/build-tag.yml)
[![Downloads](https://img.shields.io/github/downloads/leowzz/axonkey/total?style=flat&color=brightgreen)](https://github.com/leowzz/axonkey/releases)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-blue?style=flat&logo=apple&logoColor=white)](#系统要求)
[![Windows 11 x64](https://img.shields.io/badge/Windows-11%20x64-0078D4?style=flat)](#系统要求)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8D8?style=flat&logo=tauri&logoColor=white)](./src-tauri/Cargo.toml)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=flat&logo=react&logoColor=white)](./package.json)

[**⬇ 下载 Axonkey（macOS / Windows）**](https://github.com/leowzz/axonkey/releases)

## 界面截图

<table>
<tr>
<th width="50%">首页</th>
<th width="50%">按键配置</th>
</tr>
<tr>
<td align="center"><a href="./docs/images/axonkey-home.png"><img src="./docs/images/axonkey-home.png" height="280" alt="Axonkey 首页，展示设备状态、系统权限、语音通道和快捷操作"></a></td>
<td align="center"><a href="./docs/images/axonkey-mapping.png"><img src="./docs/images/axonkey-mapping.png" height="280" alt="Axonkey 按键配置，展示遥控器、触发方式和行为编辑器"></a></td>
</tr>
</table>

<details>
<summary>查看总览界面</summary>

<p align="center">
<img src="./docs/images/axonkey-overview.png" width="960" alt="Axonkey 总览，展示遥控器各按键的映射行为与触发方式">
</p>

</details>

## 主要功能

- **遥控器快捷键**：为单击、双击和长按设置不同操作。
- **鼠标快捷操作**：自定义屏幕边缘的点击、滚动，以及前进／后退键。
- **组合动作**：快捷键、媒体控制、输入文本、打开应用或网站，也能按顺序执行多个步骤。
- **语音输入**：按住遥控器语音键说话，将声音传给输入法或录音应用；语音识别由所选输入法或应用完成。

## 搭配 Cursor、Claude Code 和 Codex

| 工具 | 可以配置的快捷操作 |
| --- | --- |
| [Cursor](https://cursor.com/docs/reference/keyboard-shortcuts) | 打开 AI 聊天面板、切换聊天标签页，将常用快捷键映射到遥控器或鼠标。 |
| [Claude Code](https://code.claude.com/docs/en/interactive-mode) | 输入常用提示词，或发送 `Ctrl+R` 查找历史输入。 |
| [OpenAI Codex](https://developers.openai.com/codex/app/commands) | 为桌面应用的新建会话、切换会话和打开终端配置快捷键。 |

先按上述官方说明确认目标工具的快捷键，再到 Axonkey 的“映射”中配置对应操作。快捷键作用于当前前台应用，文本写入当前聚焦的输入框。

例如，将一个遥控器按键设为输入“先阅读相关代码，给出修改计划”，另一个设为切换会话；需要口述需求时，配合语音输入法把遥控器收音转成提示词。配置步骤见 [遥控器映射](docs/USAGE.md#遥控器映射)和[鼠标映射](docs/USAGE.md#鼠标映射)。

## 系统要求

| 系统 | 首次使用需准备 |
| --- | --- |
| macOS 13 及以上（Apple Silicon / Intel） | 授予输入监控和辅助功能权限；语音功能另需安装音频驱动 |
| Windows 11 64 位 | 遥控器功能需安装输入驱动；语音功能另需安装音频驱动 |

驱动和权限均可按应用内引导设置。只使用鼠标映射时无需遥控器，Windows 也无需输入驱动。目前不支持其他遥控器、普通键盘映射或 Linux。

## 开始使用

1. 下载并安装：macOS 将应用拖入“应用程序”；Windows 运行安装包。
2. 打开 Axonkey，按引导完成授权或驱动安装。使用遥控器时，先在系统蓝牙设置中配对并唤醒 RC003。
3. 进入“映射”，选择设备、按键和目标操作，确认对应功能开关已开启。修改会自动保存并立即生效。

仅使用鼠标快捷操作时，可跳过遥控器蓝牙配对，直接在“映射”中选择鼠标并配置操作。

需要语音输入时，在输入法或录音应用中选择麦克风：macOS 选 `MiRemoteV 2ch`，Windows 选 `CABLE Output`。

详细步骤见 [使用指南](docs/USAGE.md)；无法打开应用、授权失败或按键无响应时，见 [常见问题](docs/TROUBLESHOOTING.md)。

## 使用前了解

- **本地运行**：无需账号，配置保存在本机，不上传输入或诊断信息。
- **关闭窗口后继续运行**：要停止映射，请关闭对应功能开关，或从系统托盘／菜单栏退出 Axonkey。
- **语音限制**：macOS 上长时间连续说话可能延迟或丢失尾句，目前尚未解决。[查看说明](docs/TROUBLESHOOTING.md#长时间说话时音频延迟)
- **更新**：在“关于”中检查当前主版本的更新；跨主版本需从下载页手动安装。

## 更多帮助

- [使用指南](docs/USAGE.md)：安装、映射、语音、设置与配置备份。
- [常见问题](docs/TROUBLESHOOTING.md)：启动、授权、设备连接和日志排查。
- [设备集成约定](docs/DEVICE_INTEGRATION.md)：扫描、实物绑定、同型号多实例与新设备接入。
- [开发与发布](docs/DEVELOPMENT.md)：源码运行、构建、签名与发布流程。
- [第三方说明](THIRD_PARTY_NOTICES.md)：驱动来源与许可。

灵感来自 [remote-mic-app](https://github.com/HD838A/remote-mic-app)，感谢原项目。

Windows 按键映射使用 `QuarborUniversalKeyboardDriver`，感谢 `奇桦科技有限公司` 提供的专有驱动。

## 投喂一点Token

如果 Axonkey 用着顺手，欢迎投喂一点Token，让我继续折腾好玩又好用的小功能 😄

<p align="center">
<img src="./docs/images/sponsor-wechat.png" width="320" alt="微信赞赏码：投喂一点Token">
</p>
