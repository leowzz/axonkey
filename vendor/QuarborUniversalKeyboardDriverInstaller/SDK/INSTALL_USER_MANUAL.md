# QuarborUniversalKeyboardDriverInstaller 用户手册

## 用途与部署

安装器用于为指定 BLE / HID 设备安装或卸载 `QuarborUniversalKeyboardDriver`，支持 GUI 和 UTF-8 JSON 命令行接口。目标系统为 Windows 10 1803（内部版本 17134）及以上的 x64 系统，包括 Windows 11。

将同一次构建生成的以下文件放在同一目录：

```text
QuarborUniversalKeyboardDriverInstaller.exe
QuarborUniversalKeyboardDriver.inf
QuarborUniversalKeyboardDriver.dll
QuarborUniversalKeyboardDriver.cat
```

也可将三个驱动包文件放进 EXE 旁的 `QuarborUniversalKeyboardDriver` 子目录；该子目录优先。Release 使用静态 C++ 运行库，无需额外安装 VC++ 运行库，也不调用第三方安装器 EXE。

安装前检查包文件、当前系统适用的 INF 安装节及 UMDF 策略；Release 还检查 CAT 签名及 INF/DLL 成员哈希。暂存后逐字节核对 DLL，确保 Windows 使用的文件与当前包一致。最终安装仍受 Windows 签名策略约束。

## 图形界面

无参数启动打开 GUI，支持简体中文、English、繁體中文和日本語。设备列表显示名称、实例 ID、在线/离线状态及是否已绑定本驱动。

| 控件 | 行为 |
| --- | --- |
| 安装驱动 / 重新安装驱动 | 仅对在线设备启用；未绑定时安装，已绑定时自动先卸载该设备再安装 |
| 卸载驱动 | 对已绑定或仍有活动恢复记录的设备启用，支持离线设备 |
| 全部卸载 | 清理两种 Quarbor 驱动的在线/离线绑定、独立输出设备及驱动包缓存 |
| 刷新设备 | 重新枚举设备并刷新状态 |

选择已安装本驱动的设备时，按钮自动变成“重新安装驱动”，点击即可先卸载该设备，再安装当前驱动包，无需手动执行两次操作。离线设备也显示对应按钮名称，但不能安装或重装。选择包含多个 HID 集合的父接口时，需要选择具体集合。BLE 安装同时管理配套的独立输出设备；安装失败时分别尝试恢复输入和输出设备的原绑定。

安装和卸载操作按需申请管理员权限；帮助和设备枚举不需要提权。GUI 的“全部卸载”有确认提示。

## 启动参数

```text
QuarborUniversalKeyboardDriverInstaller.exe <command> [arguments] [--output <new-json-file>]
```

| 命令 | 用途 |
| --- | --- |
| `--help` | 显示帮助，必须单独使用 |
| `--list` | 枚举支持的在线/离线设备，无需本地驱动包 |
| `--install "<instance-id>"` | 安装指定在线设备；已绑定本驱动时先卸载该设备，再重新安装 |
| `--uninstall "<instance-id>"` | 卸载指定设备，支持离线 |
| `--uninstall-all` | 全部卸载并清理两种驱动的缓存 |

每次只能指定一个命令。安装和卸载也支持 `--device "<instance-id>"`，不能与位置参数重复指定设备。实例 ID 从列表的 `instanceId` 字段获取，并始终放在引号中；离线设备可使用之前保存的 ID 或列表中的离线记录。

`--devices`、`--hid-devices`、`--hid-list`、`--get-devices`、`--get-hid-devices`、`--get-hid-device-list`、`--get-hid-device-table`、`--get-device-list`、`--status` 均为 `--list` 的别名。

`--silent` 是兼容参数，不绕过 UAC，也不改变 JSON 输出。CLI 不弹出 GUI 的全部卸载确认框或重启提示框。

`--output` 指定的文件必须尚不存在，父目录必须已存在；安装器不会覆盖文件。未指定时，JSON 写入标准输出。PowerShell 调用 GUI 子系统 EXE 时建议用 `Start-Process -Wait -PassThru` 等待完成后读取结果。

## 重新安装

继续使用安装命令即可，位置参数和 `--device` 两种形式等价：

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --install "<instance-id>"
.\QuarborUniversalKeyboardDriverInstaller.exe --install --device "<instance-id>"
```

安装器根据设备是否已绑定本驱动决定是否先卸载，不读取或比较驱动版本。同一驱动包也可以重复安装。重装仅处理所选设备及其配套输出设备，不触发“全部卸载”或全局缓存清理。

重装先校验当前包及暂存 DLL，再调用单设备卸载逻辑。卸载失败时不继续安装；成功后重新读取设备信息并安装，保留可恢复到原驱动的记录。若后续安装失败，会报告安装阶段错误，并尝试回退到卸载后的原驱动状态。

如果卸载阶段要求重启，当前操作返回 **3010**，`installationState` 为 **`restart_before_install`**，表示尚未执行新安装。请重启 Windows 后，再对同一设备执行安装命令或点击安装按钮；程序不会自动续装。若安装阶段要求重启，则安装已提交，重启即可完成。

## 卸载范围

普通卸载只处理所选通用键盘设备及配套输出设备。在线设备恢复原驱动；离线设备清理本驱动的过滤器注册并移除离线节点，保留其他厂商的过滤器。设备重新连接后由 Windows 重新枚举并选择驱动。

“全部卸载”和 `--uninstall-all` 共用流程：

1. 卸载通用键盘驱动的在线/离线绑定，清理独立输出设备及 Driver Store 包。
2. 卸载 `QuarborHIDFilterUserDriver` 的在线/离线绑定，清理其 Driver Store 包。

第一阶段失败时停止后续阶段，以保留恢复原驱动可能需要的包。失败或需要重启时会报告；修复问题或重启后可重试。该流程复用后端代码，不需要另一个安装器 EXE 或旧驱动源文件包。

## JSON 结果和退出码

所有结果包含 `version: 1`（JSON 格式标识）、`action`、`outcome`、`exitCode`、`rebootRequired` 和 `message`。`outcome` 为 `success`、`reboot_required` 或 `failed`。

安装和重装的 `action` 均为 `install`。正常返回时增加 `installationState`：

| 值 | 含义 |
| --- | --- |
| `installed` | 已提交首次安装，是否需要重启查看 `rebootRequired` |
| `reinstalled` | 单设备卸载后已提交重新安装，是否需要重启查看 `rebootRequired` |
| `restart_before_install` | 卸载需要重启，尚未执行新安装；重启后需再次安装 |

发生错误时返回 `failed` 和非零错误码，详细原因见 `message`，不返回上述成功/待重启状态。

列表查询成功时包含 `devices`；安装和卸载完成后也尽可能附带刷新后的列表。每个设备包含：

| 字段 | 含义 |
| --- | --- |
| `instanceId`、`name`、`hardwareId` | 实例 ID、名称、硬件 ID |
| `service`、`inf`、`section` | 当前服务、INF、安装节 |
| `present` | 设备是否在线 |
| `bound` | 是否已绑定通用键盘驱动 |
| `recoverySaved`、`recoveryActive` | 恢复记录是否存在、是否仍待处理 |

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `3010` | 需要重启 Windows；安装命令还需检查 `installationState`，判断重启后是否须再次安装 |
| `87` | 未知命令、参数缺失或组合错误 |
| `1223` | 用户取消 UAC |
| `29` | 无法创建或写入输出文件 |
| 其他非零值 | 操作失败，查看 `message` 的 Windows 错误和诊断 |

脚本应同时检查进程退出码和结果内容，不能仅凭进程启动判断成功。

## PowerShell 示例

获取设备列表：

```powershell
$installer = '.\QuarborUniversalKeyboardDriverInstaller.exe'
$listPath = Join-Path $env:TEMP (([guid]::NewGuid().ToString()) + '.json')
$process = Start-Process -FilePath $installer -ArgumentList "--list --output `"$listPath`"" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "读取失败：$($process.ExitCode)" }
$list = Get-Content -Raw -Encoding UTF8 $listPath | ConvertFrom-Json
$list.devices | Format-Table name, present, bound, instanceId
```

安装或重新安装已确认的单个设备：

```powershell
$deviceId = '<从列表复制的 instanceId>'
$resultPath = Join-Path $env:TEMP (([guid]::NewGuid().ToString()) + '.json')
$process = Start-Process -FilePath $installer -ArgumentList "--install `"$deviceId`" --output `"$resultPath`"" -Wait -PassThru
$result = Get-Content -Raw -Encoding UTF8 $resultPath | ConvertFrom-Json
$result
if ($process.ExitCode -notin 0, 3010) { throw "安装失败：$($process.ExitCode)" }
if ($result.installationState -eq 'restart_before_install') {
    Write-Host '卸载需要重启，尚未安装。请重启 Windows 后再次运行安装命令。'
} elseif ($process.ExitCode -eq 3010) {
    Write-Host '安装已提交，请重启 Windows 完成。'
}
```

单设备卸载将命令改为 `--uninstall`；全部卸载使用 `--uninstall-all`，不传设备 ID。每次使用新的输出文件名。

## 常见问题

- **设备未列出**：连接后刷新，并检查系统 HID 传输驱动是否正常启动。
- **安装或重新安装按钮不可用**：设备必须在线；连接设备后刷新列表。
- **包检查或签名失败**：确认 INF、DLL、CAT 完整且来自同一次构建，查看详细诊断。
- **暂存 DLL 不一致**：核对部署文件，必要时全部卸载清理缓存后重试。
- **设备离线**：支持卸载，安装和重装需要先连接设备。
- **返回 3010**：重启 Windows；若 `installationState=restart_before_install`，重启后还需再次安装。
- **操作失败**：保留 `message` 和 `%SystemRoot%\INF\setupapi.dev.log` 中对应时段的记录，不要手动删除 Driver Store 文件。
