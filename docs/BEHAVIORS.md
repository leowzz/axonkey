# 文本输入与路径行为

行为编辑器、流程图、配置文件和原生输入服务使用同一份 JSON。每个行为保留 `id`、`enabled` 和 `type`；序列按数组顺序执行。

| 名称 | JSON 参数 | Windows | macOS |
| --- | --- | --- | --- |
| 模拟输入文字 | `{"type":"typeText","text":"你好🙂\n第二行"}` | `SendInput` Unicode 键盘事件 | `CGEventKeyboardSetUnicodeString` |
| 粘贴文本 | `{"type":"paste","text":"你好"}` | 写入剪贴板后发送 Ctrl+V | 写入剪贴板后发送 Cmd+V |
| 打开文件或文件夹 | `{"type":"openPath","path":"C:\\Users\\name\\Documents"}` | `ShellExecuteW` 默认打开方式 | `/usr/bin/open -- <path>` |
| 打开应用 | `{"type":"openApp","path":"/Applications/Safari.app"}` | 限定 exe/com/lnk | 限定 app |

`typeText` 不读写剪贴板，保留 Unicode、emoji 和换行，不模拟特定键盘布局的物理按键。目标应用需要支持系统文字输入；安全输入框、提权窗口或自定义输入控件的系统限制仍适用。macOS 分块不会拆开 UTF-16 代理对。

保留“粘贴文本”名称和 `paste` 类型。旧实现实际也注入 Unicode；现在修正为名称所表达的剪贴板粘贴，会替换剪贴板内容，不自动恢复。依赖“不修改剪贴板”的映射应改用“模拟输入文字”。目标应用异步读取剪贴板，连续粘贴不同文本时可在序列中加入等待步骤。

`openPath` 要求完整的绝对路径；支持空格、中文和 UNC 路径。编辑时不要求目标已经存在，便于导入另一台电脑的配置；执行时检查存在性。路径直接交给系统，不拼接 shell 命令，不展开环境变量或 `~`。打开失败会记录到运行日志。

## 最小兼容约定

新增行为的首次发布目标版本为 **1.8.11**，由 `newBehaviorMinAppVersion` 统一标注。本次开发没有修改应用发布版本号。

- 只含旧行为：继续导出 `axonkey/1` 文本序列、映射 v2、备份 v2。
- 含 `typeText` 或 `openPath`（包括停用步骤）：导出 `axonkey/2` 文本序列、映射 v3、备份 v3；JSON 导出附带 `minAppVersion`。
- 序列新增指令为 `type "文字"` 和 `path "完整路径"`。原来的 `text` 指令继续表示 `paste`。
- 新客户端同时接受旧、新格式。旧客户端按其已有版本检查拒绝整个新格式，不会只导入剩余步骤；未知版本和未知指令同样拒绝。
- 新客户端读取本地旧配置时，遇到不支持的行为会禁用整个对应触发序列并输出明确错误；备份导入和配置迁移整份拒绝，不丢弃未知步骤。原生设备存储已有严格枚举解码，旧服务无法解码新行为时拒绝整个配置。
- 云端当前没有这两种行为的能力声明。含新行为的同步和社区分享在发请求前拒绝，显示原因并保留本地配置；不把新行为伪装成旧行为上传。未知云端行为库条目整条跳过，界面提示更新客户端。

这些规则保证经过导入、导出和云端边界的版本协商；无法给已经发布的旧客户端补充错误文案。直接降级运行旧程序读取新客户端的浏览器本地存储不属于受支持的迁移方式，应保留导出备份并使用支持该格式的版本恢复。

本分支已接入 Agent CLI；`capabilities` 会公布 `typeText` 和 `openPath`，`mapping set` 与 `shortcut set` 使用同一套行为序列格式。CLI 写入的配置会继续沿用这里的导入、导出、备份和云端版本兼容规则。

## 本次验证（Windows）

- `npm run build` 通过（Vite 保留已有大包体积提示）。
- `npm run test:release`：363 通过，35 项平台/环境测试跳过；随后新增的 6 项行为测试已加入该脚本。
- 新增行为及相关 UI、路径、云同步测试：74 通过。
- `cargo check --manifest-path src-tauri/Cargo.toml --lib` 通过。
- 原始 `cargo test --manifest-path src-tauri/Cargo.toml --lib input_service` 编译通过，但本机测试 EXE 缺 Common Controls v6 清单，启动报 `0xc0000139`。使用临时 manifest 和 `RUSTFLAGS=-C link-arg=/MANIFEST:EMBED -C link-arg=/MANIFESTINPUT:<manifest绝对路径>` 重新链接后：138 通过，3 项硬件测试跳过。该链接配置未写入仓库构建设置。
- 用 main（179b451）的真实旧解析器读取本次新格式：序列、映射、备份均整份拒绝。
- 浏览器检查完成添加节点、中文/emoji/多行保存、无效路径拒绝、有效路径保存、选择按钮布局与撤销；测试数据已撤销。
- macOS 原生构建、权限、真实应用接收 CGEvent 和默认程序打开路径仍需在 Mac 验证。Windows 单元测试使用现有输入事件捕获机制，未对真实前台应用或硬件执行映射。

### 改动文件

- 模型与导入导出：`src/behaviorModel.ts`、`src/appTypes.ts`、`src/appConfig.tsx`、`src/configMigration.ts`、`src/dataBackup.ts`。
- 编辑器与序列：`src/app/AppController.tsx`、`src/components/BehaviorEditor.tsx`、`src/components/WorkflowAxonkey.tsx`、`src/components/workflowActionIcons.ts`、`src/components/workflowBehaviorBridge.ts`、`src/components/workflowStepEditing.ts`、`src/styles.css`。
- 云端边界：`src/cloud/behaviorLibrary.ts`、`src/cloud/cloudData.ts`。
- 原生执行：`src-tauri/src/lib.rs`、`src-tauri/src/input_service/mod.rs`、`src-tauri/src/input_service/text_output.rs`、`src-tauri/src/input_service/launch.rs`、`src-tauri/src/input_service/remote_actions.rs`、`src-tauri/src/input_service/windows.rs`、`src-tauri/src/input_service/macos.rs`、`src-tauri/src/input_service/macos/remote_output.rs`、`src-tauri/native/macos_input.m`。
- 测试与规范：`package.json`、`test/text-path-behavior.test.mjs`、`test/common-right-modifiers.test.mjs`、`test/data-backup.test.mjs`、`docs/BEHAVIORS.md`。
