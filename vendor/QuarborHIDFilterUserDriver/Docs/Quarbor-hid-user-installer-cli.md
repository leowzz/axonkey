# QuarborHIDFilterUserDriverInstaller 参数调用文档

`QuarborHIDFilterUserDriverInstaller.exe` 管理 `QuarborHIDFilterUserDriver` 在 HID 键盘设备上的绑定。程序清单使用 `asInvoker`：读取设备表时沿用调用方的普通用户权限；执行安装、卸载或全部卸载时，只有在当前进程未提升的情况下才通过 UAC 请求管理员权限。程序不会在启动时无条件弹出 UAC。

## 调用格式

```text
QuarborHIDFilterUserDriverInstaller.exe --list [--output <结果文件>]
QuarborHIDFilterUserDriverInstaller.exe --install <设备实例 ID> [--output <结果文件>]
QuarborHIDFilterUserDriverInstaller.exe --uninstall <设备实例 ID> [--output <结果文件>]
QuarborHIDFilterUserDriverInstaller.exe --uninstall-all [--output <结果文件>]
QuarborHIDFilterUserDriverInstaller.exe --help
```

设备实例 ID 来自 `--list` 返回的 `devices[].instanceId`，例如 `HID\VID_046D&PID_C31C&MI_00\B&872E89D&0&0000`。也支持把实例 ID 写在 `--device` 后：

```text
QuarborHIDFilterUserDriverInstaller.exe --install --device "HID\VID_046D&PID_C31C&MI_00\B&872E89D&0&0000"
```

`--devices`、`--hid-devices`、`--hid-list`、`--get-devices`、`--get-hid-devices`、`--get-hid-device-list`、`--get-hid-device-table`、`--get-device-list` 和 `--status` 是 `--list` 的别名。`--silent` 为自动化兼容参数，命令行操作本身已经不创建安装器窗口；无参数启动仍打开原有 GUI。参数区分大小写，动作只能指定一次，未知参数和缺少设备 ID 返回 `87`。

## 获取 HID 设备表

```powershell
$exe = '.\QuarborHIDFilterUserDriverInstaller.exe'
$json = & $exe --list | ConvertFrom-Json
$json.devices | Select-Object instanceId, name, present, bound, service, inf, section
```

列表操作是只读的，不修改设备注册表、恢复记录或驱动包，也不请求管理员权限。设备数组只包含安装器支持的标准 HID 键盘集合，并包含在线和离线实例。字段含义如下：

| 字段 | 含义 |
| --- | --- |
| `instanceId` | Windows 设备实例 ID；安装和卸载的目标键 |
| `name` | 设备友好名称 |
| `hardwareId` | 第一个硬件 ID |
| `service` | 当前设备服务，通常为 `kbdhid` |
| `inf` / `section` | 当前绑定的 INF 和安装节 |
| `present` | 当前设备是否在线 |
| `bound` | 是否检测到 Quarbor 过滤器绑定 |
| `recoverySaved` | 是否存在原驱动恢复记录 |
| `recoveryActive` | 恢复记录是否标记为仍需解除绑定 |

## 安装、卸载和全部卸载

安装指定设备：

```powershell
$id = 'HID\VID_046D&PID_C31C&MI_00\B&872E89D&0&0000'
& $exe --install $id
if ($LASTEXITCODE -eq 3010) { Write-Host '需要重启 Windows' }
```

卸载指定设备：

```powershell
& $exe --uninstall $id
```

全部卸载会处理在线和离线设备，再移除未使用的 Quarbor 驱动包：

```powershell
& $exe --uninstall-all
```

普通用户调用变更参数时，父进程先启动 UAC 提升后的同一 EXE 并等待结果；用户取消 UAC 返回 `1223`。已经在管理员 PowerShell、服务或 SYSTEM 进程中运行时不会再次申请 UAC。驱动 API 返回重启要求时退出码为 `3010`，不会自动重启 Windows。

## JSON 输出和退出码

每个命令都会输出一个 UTF-8 JSON 对象；`--output` 会以独占新建方式额外保存同一结果，已有文件不会覆盖。安装或卸载完成后，结果尽量附带最新的 `devices` 快照。

```json
{
  "version": 1,
  "action": "install",
  "outcome": "success",
  "exitCode": 0,
  "rebootRequired": false,
  "message": "Driver operation completed.",
  "devices": []
}
```

`outcome` 为 `success`、`reboot_required` 或 `failed`。程序判断应使用进程退出码和 `rebootRequired`，不要解析 `message`。常用退出码：

| 码 | 含义 |
| ---: | --- |
| `0` | 成功 |
| `1` | Windows 或驱动操作失败 |
| `29` | 结果文件或输出写入失败 |
| `87` | 参数错误，未执行设备操作 |
| `1223` | 用户取消 UAC |
| `3010` | 操作已提交，但需要重启 |

结果文件示例：

```powershell
$resultPath = Join-Path $env:TEMP ('hid-' + [guid]::NewGuid().ToString('N') + '.json')
$p = Start-Process -FilePath $exe -ArgumentList @('--uninstall-all', '--output', $resultPath) -Wait -PassThru
$result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($p.ExitCode -eq 3010) { Write-Host '请重启 Windows' }
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw $result.message }
```

## 部署和限制

将 EXE 与 `QuarborHIDFilterUserDriver.inf`、`QuarborHIDFilterUserDriver.dll`、`QuarborHIDFilterUserDriver.cat` 按 README 的目录布局一起部署。`--list` 不要求这些文件存在；安装需要完整且受 Windows 驱动签名策略信任的包。命令行调用不会绕过签名验证，也不会强制删除其他厂商的设备绑定。
