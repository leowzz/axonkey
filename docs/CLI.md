# Axonkey Agent CLI

Axonkey CLI 让 Agent 通过本机终端查看和修改映射配置。CLI 由 Axonkey 应用负责保存并立即应用，不能在应用之外直接改配置文件。

## 安装与检查

安装桌面应用时会同时安装 `axonkey-cli`。打开终端检查：

```bash
axonkey-cli capabilities --json
axonkey-cli --version --json
```

Windows 和 macOS 使用同一套命令。应用未启动时，CLI 会启动一个后台实例处理请求。

`capabilities` 的 `applications` 返回前台及最近使用应用的真实 ID。应用绑定命令的 `--application` 使用这些 ID。`device list` 中的 `activeProfile` 是设备全局配置，`effectiveProfile` 是当前前台应用实际使用的配置；省略 `--profile` 时修改全局选中的配置。

系统鼠标使用 `--device mouse`，支持配置创建、激活及应用关联：

```bash
axonkey-cli profile create --device mouse --name "浏览器" --json
axonkey-cli profile application-set --device mouse --application "<应用 ID>" --profile "浏览器" --json
axonkey-cli profile application-list --device mouse --json
axonkey-cli profile application-toggle --device mouse --off --json
```

鼠标映射命令在保存配置并完成原生设置应用后才返回成功；`--dry-run` 不保存或应用。

映射修改的 `affectedProfiles` 列出实际受影响的配置及各自的 `before` / `after`。系统鼠标和设备实例均返回此字段，设置、替换或清除共享切换按键时可检查全部配置的变更。

## 在仓库里开发和测试

仓库根目录提供了 Makefile 快捷目标。先启动开发版 Axonkey（另开一个终端运行 `make dev`），再调用 CLI：

```bash
# 构建 debug CLI
make cli-build

# 查看能力、已添加的设备和当前状态
make cli-capabilities
make cli-device-list
make cli-status
make cli-keymap DEVICE=rc003

# 用 device list 返回的实例 ID 管理配置
make cli-profile-list INSTANCE="<实例 ID>"
make cli-profile-create INSTANCE="<实例 ID>" NAME="鼠标操作"
make cli-profile-activate INSTANCE="<实例 ID>" PROFILE="鼠标操作"

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

键位图和映射目标中的 `DEVICE=<型号>` 可以替换为 `INSTANCE="<实例 ID>"`，用于明确选择某一台设备。`cli-profile-create` 和 `cli-profile-activate` 可加 `DRY_RUN=1` 预览。

Windows 使用 GNU Make（例如 Git Bash 或 MinGW Make）时会自动选择 `axonkey-cli.exe`。复杂 JSON 序列请使用上面的 `cli-mapping-dry-run` 或 `cli-mapping-set` 目标；它们通过环境变量传递序列，避开 PowerShell 的引号规则。`make cli ARGS="..."` 更适合 `capabilities`、`status` 等简单命令。

## 常用命令

```bash
# 查看当前版本支持的设备、按键、触发方式和行为格式
axonkey-cli capabilities --json

# 列出已添加的设备，获取实例 ID、连接状态和激活配置
axonkey-cli device list --json

# 启用或停用指定设备（也支持 --device mouse）
axonkey-cli device toggle --instance "<实例 ID>" --off --json

# 查看某个按键的当前配置；同型号设备有多台时使用 --instance <ID>
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

Agent 应先运行 `capabilities --json` 和 `device list --json`，用 `--instance <ID>` 明确目标，再使用 `mapping get` 读取当前状态，接着用 `--dry-run` 展示差异，最后执行正式修改并回读。

## 设备和配置文件

`device list` 返回应用中已添加的设备实例。`capabilities` 的 `instances[]` 同样列出实例，`profiles` 按实例 ID 分组。`--instance <ID>` 直接定位其中一台；`--device <型号>` 仅在该型号只有一个已添加实例时选择它。同型号有多个实例时，命令会要求使用实例 ID，避免改错设备。省略目标时也只有一个实例才能自动选择。`--device mouse` 仍用于系统鼠标配置。

```bash
axonkey-cli profile list --instance "<实例 ID>" --json
axonkey-cli profile create --instance "<实例 ID>" --name "鼠标操作" --dry-run --json
axonkey-cli profile create --instance "<实例 ID>" --name "鼠标操作" --json
axonkey-cli profile activate --instance "<实例 ID>" --profile "鼠标操作" --json
axonkey-cli profile rename --instance "<实例 ID>" --profile "鼠标操作" --name "桌面操控" --json
axonkey-cli profile duplicate --instance "<实例 ID>" --profile "桌面操控" --json
axonkey-cli profile delete --instance "<实例 ID>" --profile "旧配置" --yes --json
axonkey-cli profile application-list --instance "<实例 ID>" --json
axonkey-cli profile application-set --instance "<实例 ID>" --application "com.example.editor" --profile "编辑配置" --json
axonkey-cli profile application-remove --instance "<实例 ID>" --application "com.example.editor" --json
axonkey-cli profile application-toggle --instance "<实例 ID>" --on --json

# 查询并套用云端或内置预制配置文件
axonkey-cli preset list --device rc003 --json
axonkey-cli preset apply --instance "<实例 ID>" --preset "mouse-control" --json
axonkey-cli preset apply --instance "<实例 ID>" --preset "media-reading" --mode overwrite --profile "默认配置" --dry-run --json

# 创建纯 Prompt 模式快捷交互窗并绑定触发键
axonkey-cli profile create --instance "<实例 ID>" --name "AI 提示词" --quick --prompt-mode --json
axonkey-cli mapping set --instance "<实例 ID>" --profile "AI 提示词" --button up \
  --sequence '[{"type":"paste","text":"请帮我总结重点","title":"总结重点"}]' --json
axonkey-cli mapping set --instance "<实例 ID>" --button menu --trigger click \
  --sequence '[{"type":"quickOverlay","profileId":"<快捷配置 ID>"}]' --json
axonkey-cli profile prompt-mode --instance "<实例 ID>" --profile "AI 提示词" --off --json
```

新配置只保留跨配置的切换按键，其余映射为空；常规配置创建后会立即激活，与界面新建配置的行为一致；带 `--quick` 创建的快捷交互配置不会覆盖当前常驻激活配置，`profile list` 会返回其 `quick`、`promptMode` 与当前绑定的 `trigger`。`preset apply` 默认使用 `--mode copy` 复制生成新配置，并保留当前设备上已设定的跨配置 `switchProfile` 切换键；传入 `--mode overwrite` 可覆写指定同类型配置。

设备实例和系统鼠标均支持 `profile rename`、`profile duplicate`、`profile delete --yes`、`profile prompt-mode --on|--off`（系统鼠标暂不支持 `preset apply`）。`profile create`、`profile activate`、`profile rename/duplicate/delete/prompt-mode`、`preset apply`、`device toggle` 和映射修改均支持 `--dry-run`，预览不会保存修改。

设备实例还支持按前台应用使用独立配置：`profile application-list` 查看绑定，`profile application-set` 将应用 ID 绑定到指定配置，`profile application-remove` 删除绑定。`--application` 应与前台应用检测返回的应用 ID 一致；设置绑定不会改变设备的全局激活配置。使用 `profile application-toggle --on` 或 `--off` 控制该实例是否跟随前台应用切换。

实例映射与界面使用同一份配置。写入结果在保存完成后返回，包含实例、配置及 revision，可用 `mapping get/list` 回读。设备未连接时也可以保存配置，实际输入效果需要连接后确认。

## 示例：鼠标模拟与 TV 键循环

以下示例使用小米 RC003 的按键 ID。在 Bash 或 zsh 中执行；先把 `INSTANCE` 替换成 `device list` 返回的目标 ID。其他型号应先查 `keymap get` 的 `keys[].id`，例如 CMIOT-A15 的确认键为 `cmiotA15.confirm`，且没有 `tv` 键。

```bash
axonkey-cli device list --json
axonkey-cli keymap get --device rc003 --json
INSTANCE="<实例 ID>"

axonkey-cli profile create --instance "$INSTANCE" --name "鼠标操作" --json

# 方向键每次移动 50 像素
for DIRECTION in up down left right; do
  axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
    --button "$DIRECTION" --trigger click \
    --sequence "[{\"type\":\"cursorMove\",\"direction\":\"$DIRECTION\",\"distance\":50}]" --json
done

# 确认键左击、返回键右击；双击确认键发送鼠标双击
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button confirm --trigger click --sequence '[{"type":"mouse","button":"left"}]' --json
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button back --trigger click --sequence '[{"type":"mouse","button":"right"}]' --json
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button confirm --trigger doubleClick \
  --sequence '[{"type":"mouse","button":"left"},{"type":"delay","ms":50},{"type":"mouse","button":"left"}]' --json

# 音量键上下滚动，主页/功能键左右滚动
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button volumeUp --sequence '[{"type":"wheel","direction":"up"}]' --json
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button volumeDown --sequence '[{"type":"wheel","direction":"down"}]' --json
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button home --sequence '[{"type":"wheel","direction":"left"}]' --json
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button menu --sequence '[{"type":"wheel","direction":"right"}]' --json

# TV 键切到下个配置，最后一个之后回到第一个
axonkey-cli mapping set --instance "$INSTANCE" --profile "鼠标操作" \
  --button tv --trigger click \
  --sequence '[{"type":"switchProfile","direction":"next","wrap":true}]' --json

axonkey-cli profile activate --instance "$INSTANCE" --profile "鼠标操作" --json
axonkey-cli mapping list --instance "$INSTANCE" --profile "鼠标操作" --json
axonkey-cli profile list --instance "$INSTANCE" --json
```

单独设置 `switchProfile` 会把同一按键、同一触发方式应用到该实例的全部配置，覆盖该位置原有映射；以后新建的配置也会继承。可先加 `--dry-run` 检查影响。清除或替换已有切换动作时会同步移除其他配置中的该切换动作，保证与界面一致。

示例涵盖移动、左右点击、双击和四向滚轮。中键、按住和拖拽尚不属于当前行为格式。

## 键位图与空间配置

`keymap get --device <型号> --json` 或 `keymap get --instance <ID> --json` 返回设备的 SVG 键位图和结构化按键元数据。遥控器设备的 `result.artwork.svg` 是完整 SVG，`result.artwork.viewBox` 是 SVG 坐标范围；`result.keys` 为每个按键提供 `id`、`label`、`regionPath`、可选 `regionTransform`、百分比坐标和 SVG 锚点。`position.percent.y` 从上到下取 0 到 100，适合表达“上半部分”等空间条件；`position.zone.vertical` 按三等分提供 `upper`、`middle`、`lower`，`layout.verticalZones` 返回对应边界。

例如，Agent 可以先获取 `rc003` 键位图，筛选 `position.percent.y < 50` 的按键，再对这些按键逐个调用 `mapping set` 或 `shortcut set`。当前内置版本使用 SVG 生成的 `keys[].id` 作为 `--button`，保持既有配置键名兼容。`regionTransform` 与 `regionPath` 一起还原局部坐标的手柄热区；百分比位置和锚点始终在根画布中。协议及后续 stable Key 版本迁移规则见 [SVG 设备描述协议](DEVICE_DESCRIPTOR_SVG.md)。

系统鼠标没有固定的物理键位图，因此 `keymap get --device mouse` 返回 `artwork: null`，并通过 `keys[].context` 和语义化输入 ID 描述作用范围。

## 行为格式

`--sequence` 和 `--actions` 都接受 JSON 数组。数组中的行为按顺序执行；空数组表示保留原始输入。输入时 `enabled` 可以省略，返回结果始终包含 `enabled`。

```json
{"type":"key","key":"Esc"}
{"type":"shortcut","keys":["Mod","Shift","P"]}
{"type":"wheel","direction":"up"}
{"type":"mouse","button":"back"}
{"type":"cursorMove","direction":"right","distance":50}
{"type":"paste","text":"你好","title":"问候"}
{"type":"typeText","text":"你好🙂\n第二行","title":"多行文本"}
{"type":"copyText","text":"常用片段","title":"复制到剪贴板"}
{"type":"delay","ms":30}
{"type":"openApp","path":"C:\\Program Files\\Cursor\\Cursor.exe"}
{"type":"openPath","path":"C:\\Users\\name\\Documents"}
{"type":"openWebsite","url":"https://example.com"}
{"type":"runCommand","command":"open -a \"Raycast\"","workingDirectory":"/Users/name/project","title":"打开 Raycast"}
{"type":"httpRequest","method":"POST","url":"http://127.0.0.1:8123/api/webhook","headers":{"Content-Type":"application/json"},"body":"{\"action\":\"toggle\"}","title":"触发本机 Webhook"}
{"type":"switchProfile","direction":"next","wrap":true}
{"type":"quickOverlay","profileId":"<快捷配置 ID>"}
{"type":"clipboardOverlay","action":"paste"}
{"type":"disabled"}
```

快捷键 token 使用统一格式。`Mod` 在 Windows 表示 `Ctrl`，在 macOS 表示 `Cmd`；也接受 `Command`、`Cmd`、`Option`、`Esc` 等常见别名。一个快捷键最多包含一个普通键，修饰键顺序会自动规范化。

`typeText`、`paste`、`copyText`、`runCommand` 与 `httpRequest` 均支持可选 `title` 字段，用于在快捷交互窗及纯 Prompt 模式面板中展示更简洁的短标题。`typeText` 通过系统文字输入发送 Unicode 文本，不读取或修改剪贴板；`paste` 会替换剪贴板后执行粘贴；`copyText` 仅写入剪贴板而不发送粘贴快捷键。`openPath` 通过系统默认程序打开完整的绝对文件或文件夹路径，支持空格、中文和 UNC 路径。`runCommand` 支持可选绝对路径 `workingDirectory`，在后台线程非阻塞执行命令（macOS 使用 `/bin/zsh -lc`，Windows 使用隐藏窗口 PowerShell）；`httpRequest` 支持 `GET|POST|PUT|PATCH|DELETE`、可选 `headers`（最多 16 项）与可选 `body`，在后台异步发起 10 秒超时请求并支持 localhost / 局域网地址。`quickOverlay` 必须作为触发方式的唯一行为使用，`profileId` 支持配置 ID 或名称（解析后保存为配置 ID）。`clipboardOverlay` 同样必须作为触发方式的唯一行为使用，按下后在顶层唤起简洁的剪贴板历史列表浮窗（由新到旧排序），支持上下键/侧键/滚轮切换条目、确认键（OK）粘贴或复制当前选中项、返回/Esc 或再按触发键关闭；可选 `action` 为 `"paste"`（默认，确认后直接粘贴）或 `"copyText"`（确认后仅写入剪贴板）。

包含 `clipboardOverlay`、`copyText`、`runCommand`、`httpRequest`、`typeText` 或 `openPath` 的配置在后续文本序列、映射或备份导出时会自动使用对应的新版本格式（含最低版本 `minAppVersion`，其中含 `clipboardOverlay` 时为 `1.9.21`）；CLI 协议本身仍保持 `axonkey.cli/v1`。

设备型号与按键 ID 以 `capabilities` 和 `keymap get` 返回值为准，实际设备实例以 `device list` 为准。触发方式为 `click`、`doubleClick`、`longPress`，省略时为 `click`。

## 新设备输入采集（capture）

`axonkey-cli capture` 用于连接未知新型号遥控器、副键盘或手柄，枚举本机候选 HID / Quarbor 节点、安全挂载或卸载拦截驱动、逐键采集原始按下/松开报文，并把 `axonkey-device-svg` 产出的待采集 SVG 草稿编译为通过引擎校验的 `axonkey.device/1` 描述符。该命令族直接在 CLI 进程内调用原生采集引擎，不要求 Axonkey 桌面应用处于运行状态。

```bash
# 列出候选输入设备；--with-gatt 同时读取蓝牙低功耗 0x180A 厂商/型号/固件特征
axonkey-cli capture list --with-gatt --json

# Windows 下为目标设备挂载或恢复 Quarbor 拦截驱动（会触发系统 UAC 授权）
axonkey-cli capture attach --instance-id "<设备实例 ID>" --json
axonkey-cli capture detach --instance-id "<设备实例 ID>" --json

# 单独采集一个按键的按下与松开原始报文
axonkey-cli capture key \
  --instance-id "<设备实例 ID>" \
  --input-id "tcl.rc802a.home" \
  --timeout-ms 12000 \
  --json

# 按草稿按键清单执行可断点续采的交互式向导（省略 --out 时默认输出 <draft>.captured.svg）
axonkey-cli capture wizard \
  --instance-id "<设备实例 ID>" \
  --draft docs/device-drafts/tcl-rc802a.svg \
  --session-file docs/device-drafts/tcl-rc802a.capture.json \
  --out docs/device-drafts/tcl-rc802a.captured.svg

# 将 SVG 草稿与采集样本编译为带 ak:identity / ak:reports / ak:hid-capture 的正式描述符并校验
axonkey-cli capture compile \
  --draft docs/device-drafts/tcl-rc802a.svg \
  --session docs/device-drafts/tcl-rc802a.capture.json \
  --out docs/device-drafts/tcl-rc802a.captured.svg \
  --markdown-out docs/device-drafts/tcl-rc802a.captured.md \
  --status active \
  --json
```

候选设备按风险分为三级：`safe`（蓝牙遥控器、Consumer `0x0C`、厂商页、手柄）可直接挂载；`caution`（存在多把物理键盘时的外接副键盘）需确认后加 `--allow-caution`；`blocked`（鼠标/指针设备或机器唯一的物理键盘）默认拒绝挂载，避免锁死主输入。虚拟输出节点（`ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT`）与内置 ACPI/PS2 设备自动排除。完整引导步骤见 [axonkey-device-capture skill](../.agents/skills/axonkey-device-capture/SKILL.md)。

## 给 Agent 的简短说明

```text
修改 Axonkey 配置时先运行 axonkey-cli capabilities --json 和 axonkey-cli device list --json。
使用 --instance <ID> 明确目标；--device <型号> 仅在该型号只有一个实例时可用。
需要开箱即用方案时，先运行 preset list 查看官方/云端预制，再用 preset apply --preset <slug> 复制或覆写配置。
用 profile create --name <名称> 新建配置（--quick [--prompt-mode] 可建快捷交互窗），profile activate --profile <ID或名称> 激活；支持 profile rename/duplicate/delete --yes。
需要按空间选择按键时先运行 axonkey-cli keymap get --device <id> --json，使用 keys[].position.percent 和 keys[].id。
用 mapping get 查看目标按键当前行为，用 --dry-run 预览变更。
快捷键使用 Mod、Ctrl、Shift、Alt 等 token；Mod 会按系统转换。
mapping set 的 --sequence 是按顺序执行的行为数组，空数组表示保留原始输入。
switchProfile、quickOverlay 和 clipboardOverlay 均必须是唯一行为；switchProfile 会应用到全部常规配置并由新配置继承。
清除映射或删除配置必须显式传入 --yes。写入后用 mapping get/list 或 profile list 回读。
```

## 安装后的命令入口

首页顶部「AI 配置」栏和设置 -> 关于页「用 Agent 配置」卡片会自动将当前运行应用的 `axonkey-cli` 绝对路径带入提示词，直接复制给 Agent 即可调用。

Windows 安装器不会修改系统或用户的 `PATH`。`axonkey-cli.exe` 位于应用安装目录（默认 `%LOCALAPPDATA%\Axonkey\axonkey-cli.exe`；自定义安装路径可从注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Axonkey` 的 `InstallLocation` 读取），可直接按完整路径调用，或自行将安装目录加入 `PATH`。

macOS 的 DMG 是拖拽安装，首次打开 Axonkey 时会自动把应用包内的 CLI 注册到 `~/.local/bin/axonkey-cli`。确认 `~/.local/bin` 已在 PATH 后，重新打开终端即可。若该路径已有自己的 CLI 文件或链接，Axonkey 不会覆盖它；也可以直接调用 `/Applications/Axonkey.app/Contents/MacOS/axonkey-cli`。
