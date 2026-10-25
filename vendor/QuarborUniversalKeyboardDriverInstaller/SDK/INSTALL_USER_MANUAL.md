# QuarborUniversalKeyboardDriverInstaller 用户手册

## 1. 用途

`QuarborUniversalKeyboardDriverInstaller.exe` 用于在 Windows x64 上为指定 BLE / HID 设备安装、升级和卸载 `QuarborUniversalKeyboardDriver`。

安装器支持两种使用方式：

- 双击 EXE 使用图形界面；
- 在 PowerShell、批处理或其他程序中使用命令行，并读取 UTF-8 JSON 结果。

支持 Windows 10 1803（内部版本 17134）及以上版本和 Windows 11。安装器只支持 x64。


## 2. 命令行格式

```text
QuarborUniversalKeyboardDriverInstaller.exe <command> [arguments] [--output <new-json-file>]
```

`--output` 指向的文件必须尚不存在。安装器使用 `CREATE_NEW` 创建文件，不会覆盖已有文件。未指定 `--output` 时，JSON 写到标准输出；如果从 PowerShell 启动 GUI 子系统 EXE，建议使用 `Start-Process -Wait -PassThru` 等待进程结束。

`--silent` 是兼容参数，当前不会隐藏 UAC，也不会改变 JSON 输出。以下参数是 `--list` 的兼容别名：`--devices`、`--hid-devices`、`--hid-list`、`--get-devices`、`--get-hid-devices`、`--get-hid-device-list`、`--get-hid-device-table`、`--get-device-list` 和 `--status`。

设备 ID 可以作为命令后的参数传入，也可以使用 `--device`：

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --check-upgrade "HID\VID_1234&PID_5678\7&ABC"
.\QuarborUniversalKeyboardDriverInstaller.exe --check-upgrade --device "HID\VID_1234&PID_5678\7&ABC"
```

包含反斜杠、`&` 或空格的实例 ID 应始终放在引号中。

### 3.1 查看帮助

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --help
```

帮助操作只读，不请求 UAC。

### 3.2 获取版本

获取当前目录驱动包版本和所有设备的已安装版本：

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --version
```

查询指定设备：

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --version --device "<instance-id>"
```

结果中的 `packageVersion` 是当前 DLL 的四段版本，例如 `0.9.1.0`；`devices[].driverVersion` 是 Windows 设备属性中的已安装版本。

### 3.3 检查是否有升级

检查所有设备：

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --check-upgrade --output check.json
```

检查指定设备：

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --check-upgrade --device "<instance-id>"
```

查询不会修改设备，也不会请求 UAC。判断规则如下：

| `upgradeStatus` | 含义 |
| --- | --- |
| `available` | 设备在线、已绑定本驱动，且已安装版本低于当前包 |
| `up_to_date` | 版本相同 |
| `installed_newer` | 设备版本高于当前包，不执行降级 |
| `offline` | 设备版本较低，但当前离线 |
| `not_installed` | 设备尚未绑定本驱动 |
| `version_unknown` | 已安装版本不是有效的四段数字 |
| `package_unknown` | 仅用于兼容普通列表查询；显式版本查询读取包失败会直接返回错误 |

顶层 `upgradeAvailable` 和 `upgradeCount` 是当前查询范围的汇总。只有 `upgradeAvailable=true` 时才建议执行升级。

### 3.4 安装驱动

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --install "<instance-id>"
```

首次安装会保存原驱动恢复信息，只绑定选择的设备。BLE 设备还会创建或更新 Quarbor 独立键盘、Consumer Control 和鼠标输出设备。

如果指定设备已经绑定本驱动且当前包版本更高，`--install` 会自动按升级流程处理；同版本或更高版本不会强制重装。需要明确升级时使用 `--upgrade`。

### 3.5 升级指定设备

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --upgrade "<instance-id>" --output upgrade.json
```

升级采用 Windows 的指定设备直接更新流程，保留设备实例，不先卸载回系统驱动。输入设备和 BLE 独立输出设备分别更新；如果其中一步失败，会分别尝试回退。

升级成功后，安装器会检查新 INF 和版本是否已经绑定到设备，再尝试清理不再使用的旧 Quarbor 驱动包。仍被其他在线或离线设备引用、或因重启尚未完成的旧包会保留，并在 JSON 的 `cleanup` 数组中说明原因。清理失败不会撤销已经成功的升级。

### 3.6 卸载指定设备

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --uninstall "<instance-id>"
```

该操作恢复安装前保存的原驱动。单设备卸载不会强制删除仍可能被其他设备使用的驱动包。

### 3.7 全部卸载

```powershell
.\QuarborUniversalKeyboardDriverInstaller.exe --uninstall-all --output cleanup.json
```

该操作按以下顺序执行：

1. 恢复 `QuarborUniversalKeyboardDriver` 的在线和离线设备；
2. 删除其独立输出设备并清理已发布包；
3. 清理 `QuarborHIDFilterUserDriver` 的在线和离线设备及其 Driver Store 包。

任一阶段失败都会保留必要的恢复记录和错误详情，修复问题或重启后可以重新执行。此命令需要管理员权限。

## 4. JSON 结果

典型查询结果结构如下：

```json
{
  "version": 1,
  "action": "check-upgrade",
  "outcome": "success",
  "exitCode": 0,
  "rebootRequired": false,
  "packageVersion": "0.9.1.0",
  "upgradeAvailable": true,
  "upgradeCount": 1,
  "devices": [
    {
      "instanceId": "HID\\VID_1234&PID_5678\\7&ABC",
      "name": "Example HID Keyboard",
      "driverVersion": "0.9.0.0",
      "upgradeAvailable": true,
      "upgradeStatus": "available",
      "present": true,
      "bound": true,
      "recoverySaved": true,
      "recoveryActive": true
    }
  ],
  "cleanup": []
}
```

升级或安装结果还可能包含 `cleanup`：

| 状态 | 含义 |
| --- | --- |
| `removed` | 旧包已删除 |
| `current` | 当前或更高版本包，保留 |
| `in_use` | 仍被设备引用，保留 |
| `restart_required` | 重启完成前保留 |
| `failed` | 清理失败，查看 `detail` 和 `error` |

`outcome` 可能为 `success`、`success_with_warnings`、`reboot_required` 或 `failed`。`message` 包含面向用户的说明；`devices` 和 `cleanup` 适合程序读取。

## 5. 退出码

| 退出码 | 含义 |
| ---: | --- |
| `0` | 操作成功；查询成功或升级成功且无需重启 |
| `29` | 无法创建或写入 `--output` 文件 |
| `87` | 参数无效 |
| `3010` | 操作已提交，但 Windows 要求重启 |
| `1223` | 用户取消 UAC |
| 其他 Windows 错误码 | 操作失败，详情在 JSON 的 `message` 中 |

查询命令读取不到本地 DLL、INF 或 CAT 时不会返回“没有升级”，而会返回失败结果。升级返回 `3010` 时，必须在重启后再次使用 `--version` 或 `--check-upgrade` 确认设备已加载新版本。

## 6. 故障排查

1. **找不到驱动包**：确认 EXE、INF、DLL、CAT 在同一目录，或三个驱动文件在同名子目录。
2. **版本读取失败**：确认 DLL 包含有效的四段文件版本，例如 `0.9.1.0`，并且 INF `DriverVer` 与其一致。
3. **设备不在列表**：检查设备是否已经被 Windows 枚举；BLE 设备需要先确认 HID-over-GATT 服务正常。
4. **多个 HID 集合**：不要使用父接口 ID，改用列表中具体的 HID 集合实例 ID。
5. **升级后返回 3010**：重启 Windows，再执行 `--check-upgrade --device "<instance-id>"`。
6. **旧包显示 `in_use`**：说明仍有其他在线或离线设备引用它；连接设备并卸载/升级，或使用“全部卸载”。
7. **安装或升级失败**：保留 `message`、`cleanup` 和 `%SystemRoot%\INF\setupapi.dev.log` 中对应时间段的记录，不要手动删除 Driver Store 文件。

安装器不会强制删除仍被设备引用的驱动包，也不会降级到低于设备当前版本的包。
