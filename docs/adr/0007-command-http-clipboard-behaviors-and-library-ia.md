# 0007. 命令 / HTTP / 剪贴板行为边界与行为库信息架构

- 状态：`accepted`
- 日期：2026-11-21
- 关联 Issue：[leowzz/axonkey#104](https://github.com/leowzz/axonkey/issues/104)

## 背景

1. 既有行为库将默认入口设为需要联网与人工精选的 `推荐` 视图（离线时仅展示局部“常用行为/组合行为”），且内置目录混杂了 `控制`（内含文本粘贴、等待、打开应用/网站/文件与禁用）、仅含 1 项的 `键盘`、独立靠前的 `macOS` 与后置的 19 个快捷键，同时点击卡片主体弹出静态预览而非直接添加，导致普通用户极难快速定位并配置常用动作。
2. 随着 AI Agent 与高阶用户越来越多通过 `axonkey-cli` 与工作流编排器批量绑定自动化动作，现有模型缺少直接触发本地脚本/命令、Webhook / 本地 API HTTP 请求以及纯写入剪贴板（不立即发送粘贴快捷键）的原生能力。
3. 同时，`runCommand` 与 `httpRequest` 涉及本地任意命令执行与内网请求能力，一旦混入公开社区行为库，将带来跨用户提示诱导或内网探测风险，必须明确协议兼容版本、执行线程模型与云端分享边界。

## 决定

1. **行为协议与兼容版本门控**：
   - 新增三种标准行为：
     - `copyText`：`{ type: 'copyText', text: string, title?: string }`（仅写入剪贴板，不模拟粘贴组合键）。
     - `runCommand`：`{ type: 'runCommand', command: string, workingDirectory?: string, title?: string }`（命令行限长 4096 字符且禁止 NUL；可选工作目录须为绝对路径）。
     - `httpRequest`：`{ type: 'httpRequest', method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers?: Record<string, string>, body?: string, title?: string }`（HTTP/HTTPS 无内嵌凭据 URL，最多 16 个合法请求头，请求体上限 16384 字符）。
   - `axonkey/2` 文本序列化新增 `copy`、`cmd`、`http` 指令；包含任一新行为的配置导出（映射 JSON 与全量备份）自动提升 `minAppVersion` 至 `1.9.19`，避免旧版客户端静默降级或部分导入。
   - **取舍（版本优先级）**：当备份同时包含快捷交互窗（`1.9.11`）与新行为时，强制取更高版本门槛 `1.9.19`。
2. **原生输入服务非阻塞执行模型**：
   - **线程隔离**：HID 监听线程与低延迟按键/鼠标分发线程绝不等待命令进程或 HTTP 网络响应。
   - `runCommand` 通过独立命名工作线程（`axonkey-cmd`）运行并在同一工作线程内等待进程退出及记录状态，防止僵尸进程泄漏；macOS 使用 `/bin/zsh -lc`，Windows 使用隐藏窗口 PowerShell（`-NoProfile -NonInteractive -WindowStyle Hidden` + `CREATE_NO_WINDOW`）。
   - `httpRequest` 复用既有 `reqwest` 依赖并派发至 `tauri::async_runtime::spawn`，设置 10 秒请求超时，在异步任务内记录响应状态与错误。
   - **取舍（安全启动 vs. Shell 语义）**：应用与网页启动仍保持直传 OS API，不使用 shell 解析；仅在显式 `runCommand` 动作中提供完整 shell 语义，由用户在入口与界面清晰区分。
3. **四层社区安全边界**：
   - `runCommand` 与 `httpRequest` 允许存在于**本地配置、已保存序列、`axonkey-cli`、本地备份导入导出以及用户个人加密/私有云同步**。
   - 前后端共同强制禁止将其发布到**公开社区行为库或官方推荐池**：前端分享弹窗 `BehaviorShareDialog`、`behaviorLibrary.ts`（提交与解析端双重拦截），以及 Relay 服务端 `ValidateBehaviorSequence` 对公开序列统一拒绝 `runCommand` / `httpRequest` / `quickOverlay`（`copyText` 属于无副作用纯文本剪贴板动作，允许公开分享）。
4. **行为库信息架构重构**：
   - 默认入口切换为本地完整的「内置」Tab，来源 Tab 按「内置 | 推荐 | 社区 | 我的」排序；内置分类合并精简为按高频排序的 6 个互斥分组：「键盘」「鼠标」「媒体」「文本」「系统与命令」「流程控制」。
   - 点击卡片主体（带 5px 拖拽位移阈值区分）直接添加行为，多步骤/已保存/云端条目提供独立「查看详情」按钮；行内直接展示单行说明，并支持中英文关键词搜索。

## 主要取舍与影响

- **单客户端直接执行命令 / HTTP vs. 白名单沙箱**：桌面映射工具的核心价值在于让用户自控本机工作流（如触发本地脚本、Home Assistant、RayCast / Shortcuts 桥接等），因此本机配置不额外做命令白名单限制；代价是必须在公开社区分享边界做硬性阻断，防止他人恶意序列直接通过“一键添加社区行为”在本机执行命令或请求局域网服务。
- **行为库分类调整对历史分类代码的兼容**：客户端向管理员推荐 API 提交时映射新旧 `category_code`，Relay 保留既有 6 个历史代码并增补 `text` / `system`，确保存量云端数据库条目零迁移兼容。
