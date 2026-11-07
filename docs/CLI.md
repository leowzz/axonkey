# Axonkey Agent CLI

Axonkey CLI 让 Agent 通过本机终端查看和修改映射配置。CLI 由 Axonkey 应用负责保存并立即应用，不能在应用之外直接改配置文件。

## 安装与检查

安装桌面应用时会同时安装 `axonkey-cli`。打开终端检查：

```bash
axonkey-cli capabilities --json
```

Windows 和 macOS 使用同一套命令。应用未启动时，CLI 会启动一个后台实例处理请求。

## 在仓库里开发和测试

仓库根目录提供了 Makefile 快捷目标。先启动开发版 Axonkey（另开一个终端运行 `make dev`），再调用 CLI：

```bash
# 构建 debug CLI
make cli-build

# 查看能力和当前状态
make cli-capabilities
make cli-status
make cli-keymap DEVICE=rc003

# 读取映射；PROFILE 可选
make cli-mapping-get DEVICE=rc003 BUTTON=voice TRIGGER=click PROFILE="默认配置"
make cli-mapping-list DEVICE=rc003

# 先预览，再应用快捷键
make cli-shortcut-dry-run DEVICE=rc003 BUTTON=voice TRIGGER=click KEYS="Mod+Shift+P"
make cli-shortcut-set DEVICE=rc003 BUTTON=voice TRIGGER=click KEYS="Mod+Shift+P"

# 设置完整行为序列
make cli-mapping-dry-run \
  DEVICE=rc003 BUTTON=voice TRIGGER=click \
  SEQUENCE='[{"type":"paste","text":"请先阅读相关代码"},{"type":"key","key":"Enter"}]'
make cli-mapping-set \
  DEVICE=rc003 BUTTON=voice TRIGGER=click \
  SEQUENCE='[{"type":"paste","text":"请先阅读相关代码"},{"type":"key","key":"Enter"}]'

# 清除映射
make cli-mapping-clear DEVICE=rc003 BUTTON=voice TRIGGER=click
```

也可以直接透传任意 CLI 参数：

```bash
make cli ARGS='capabilities --json'
```

Windows 使用 GNU Make（例如 Git Bash 或 MinGW Make）时会自动选择 `axonkey-cli.exe`。复杂 JSON 序列请使用上面的 `cli-mapping-dry-run` 或 `cli-mapping-set` 目标；它们通过环境变量传递序列，避开 PowerShell 的引号规则。`make cli ARGS="..."` 更适合 `capabilities`、`status` 等简单命令。

## 常用命令

```bash
# 查看当前版本支持的设备、按键、触发方式和行为格式
axonkey-cli capabilities --json

# 查看某个按键的当前配置
axonkey-cli mapping get \
  --device rc003 --button voice --trigger click --json

# 获取设备键位图 SVG 和可供 Agent 筛选的坐标元数据
axonkey-cli keymap get --device rc003 --json

# 只预览修改
axonkey-cli shortcut set \
  --device rc003 --button voice --trigger click \
  --keys "Mod+Shift+P" --dry-run --json

# 应用快捷键
axonkey-cli shortcut set \
  --device rc003 --button voice --trigger click \
  --keys "Mod+Shift+P" --json

# 设置一个完整的行为序列
axonkey-cli mapping set \
  --device rc003 --button voice --trigger click \
  --sequence '[{"type":"paste","text":"请先阅读相关代码"},{"type":"delay","ms":30},{"type":"key","key":"Enter"}]' \
  --json

# 清空序列，恢复原始输入
axonkey-cli mapping clear \
  --device rc003 --button voice --trigger click --yes --json
```

Agent 应先运行 `capabilities --json`，再使用 `mapping get` 读取当前状态，接着用 `--dry-run` 展示差异，最后执行正式修改。

## 键位图与空间配置

`keymap get --device <id> --json` 返回设备的 SVG 键位图和结构化按键元数据。遥控器设备的 `result.artwork.svg` 是完整 SVG，`result.artwork.viewBox` 是 SVG 坐标范围；`result.keys` 为每个按键提供 `id`、`label`、`regionPath`、百分比坐标和 SVG 锚点。`position.percent.y` 从上到下取 0 到 100，适合表达“上半部分”等空间条件；`position.zone.vertical` 按三等分提供 `upper`、`middle`、`lower`，`layout.verticalZones` 返回对应边界。

例如，Agent 可以先获取 `rc003` 键位图，筛选 `position.percent.y < 50` 的按键，再对这些按键逐个调用 `mapping set` 或 `shortcut set`。SVG 仅用于展示和定位，实际配置仍使用 `keys[].id` 作为 `--button`。

系统鼠标没有固定的物理键位图，因此 `keymap get --device mouse` 返回 `artwork: null`，并通过 `keys[].context` 和语义化输入 ID 描述作用范围。

## 行为格式

`--sequence` 和 `--actions` 都接受 JSON 数组。数组中的行为按顺序执行；空数组表示保留原始输入。输入时 `enabled` 可以省略，返回结果始终包含 `enabled`。

```json
{"type":"key","key":"Esc"}
{"type":"shortcut","keys":["Mod","Shift","P"]}
{"type":"wheel","direction":"up"}
{"type":"mouse","button":"back"}
{"type":"cursorMove","direction":"right","distance":50}
{"type":"paste","text":"你好"}
{"type":"typeText","text":"你好🙂\n第二行"}
{"type":"delay","ms":30}
{"type":"openApp","path":"C:\\Program Files\\Cursor\\Cursor.exe"}
{"type":"openPath","path":"C:\\Users\\name\\Documents"}
{"type":"openWebsite","url":"https://example.com"}
{"type":"switchProfile","direction":"next","wrap":true}
{"type":"disabled"}
```

快捷键 token 使用统一格式。`Mod` 在 Windows 表示 `Ctrl`，在 macOS 表示 `Cmd`；也接受 `Command`、`Cmd`、`Option`、`Esc` 等常见别名。一个快捷键最多包含一个普通键，修饰键顺序会自动规范化。

`typeText` 通过系统文字输入发送 Unicode 文本，不读取或修改剪贴板；`paste` 会替换剪贴板后执行粘贴。`openPath` 通过系统默认程序打开完整的绝对文件或文件夹路径，支持空格、中文和 UNC 路径。

包含 `typeText` 或 `openPath` 的配置在后续文本序列、映射或备份导出时会自动使用对应的新版本格式；CLI 协议本身仍保持 `axonkey.cli/v1`。

设备 ID 为 `rc003`、`cmiotA15` 和 `mouse`，触发方式为 `click`、`doubleClick`、`longPress`。`profile` 可以省略，省略时使用该设备当前激活的配置文件；也可以填写配置文件 ID 或名称。

## 给 Agent 的简短说明

```text
修改 Axonkey 配置时先运行 axonkey-cli capabilities --json。
需要按空间选择按键时先运行 axonkey-cli keymap get --device <id> --json，使用 keys[].position.percent 和 keys[].id。
用 mapping get 查看目标按键当前行为，用 --dry-run 预览变更。
快捷键使用 Mod、Ctrl、Shift、Alt 等 token；Mod 会按系统转换。
mapping set 的 --sequence 是按顺序执行的行为数组，空数组表示保留原始输入。
清除映射必须显式传入 --yes。
```

## 安装后的命令入口

Windows 安装器会把 Axonkey 安装目录加入当前用户的 PATH。安装前已经打开的终端需要重新打开，然后直接运行 `axonkey-cli`。

macOS 的 DMG 是拖拽安装，首次打开 Axonkey 时会自动把应用包内的 CLI 注册到 `~/.local/bin/axonkey-cli`。确认 `~/.local/bin` 已在 PATH 后，重新打开终端即可。若该路径已有自己的 CLI 文件或链接，Axonkey 不会覆盖它；也可以直接调用 `/Applications/Axonkey.app/Contents/MacOS/axonkey-cli`。
