# Quarbor 虚拟麦克风安装器用户手册

## 1. 安装准备

支持 Windows 10 1809（内部版本 17763）及以上的 x64 系统，包括 Windows 11。

将同一版本的以下文件放在同一目录，然后在该目录运行安装器：

```text
QuarborVirtualMicrophoneDriverInstaller.exe
QuarborVirtualMicrophoneDriver.inf
QuarborVirtualMicrophoneDriver.sys
QuarborVirtualMicrophoneDriver.cat
```

安装前请确保 Windows 音频服务正常运行。Release 安装器要求驱动包具有数字签名。

查询状态、查看帮助和卸载时，只需安装器 EXE，不要求提供上述三个驱动文件。

## 2. 使用窗口安装和卸载

### 安装

1. 双击 `QuarborVirtualMicrophoneDriverInstaller.exe`。
2. 在 Windows 管理员权限提示中选择“是”。
3. 等待状态检查完成，点击“安装驱动”。
4. 查看操作日志，确认安装结果；若提示需要重启，请重启 Windows。

### 卸载

1. 打开安装器并允许管理员权限。
2. 等待状态检查完成，点击“卸载驱动”。
3. 查看操作日志，确认卸载结果；若提示需要重启，请重启 Windows。

若显示“重新检查”，点击后重新获取状态。程序不会自动重启电脑。

## 3. 命令行参数

在安装器所在目录打开终端。无参数启动时打开窗口；带命令参数启动时返回 JSON 结果。

```text
QuarborVirtualMicrophoneDriverInstaller.exe <命令> [--silent] [--output "<结果文件路径>"]
```

每次只能指定一个命令，不需要传入设备 ID。

| 命令 | 用途 | 别名 |
| --- | --- | --- |
| `--status` | 查询虚拟麦克风设备状态 | `--list` |
| `--install` | 安装驱动 | 无 |
| `--uninstall` | 卸载虚拟麦克风驱动并清理残留 | `--uninstall-all` |
| `--help` | 查看命令帮助 | 无 |

| 可选参数 | 说明 |
| --- | --- |
| `--output "<路径>"` | 将 UTF-8 JSON 写入指定文件；文件必须尚不存在，父目录必须存在且可写 |
| `--silent` | 兼容参数，不改变返回结果，也不会跳过 Windows 管理员权限提示 |

不指定 `--output` 时，结果写入标准输出。指定后，结果写入文件。路径包含空格时请加双引号。

状态查询和帮助不需要管理员权限。安装和卸载会在需要时申请管理员权限；取消授权时返回 `1223`。

### 命令示例

查询状态：

```powershell
.\QuarborVirtualMicrophoneDriverInstaller.exe --status --output status-result.json
```

安装驱动：

```powershell
.\QuarborVirtualMicrophoneDriverInstaller.exe --install --output install-result.json
```

卸载驱动：

```powershell
.\QuarborVirtualMicrophoneDriverInstaller.exe --uninstall --output uninstall-result.json
```

查看帮助：

```powershell
.\QuarborVirtualMicrophoneDriverInstaller.exe --help
```

重复执行时，请使用新的结果文件名。安装器不会覆盖已有文件。

### PowerShell 等待完成并读取结果

脚本调用时使用 `Start-Process -Wait -PassThru`，等待操作结束后再读取结果。下面的示例只查询状态，并为每次调用生成独立的结果文件：

```powershell
$exe = '.\QuarborVirtualMicrophoneDriverInstaller.exe'
$output = Join-Path $PWD.Path ('vmic-result-' + [guid]::NewGuid().ToString('N') + '.json')
$arguments = '--status --output "' + $output + '"'

$process = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru
$process.ExitCode

if (Test-Path -LiteralPath $output) {
    $result = Get-Content -LiteralPath $output -Raw -Encoding UTF8 | ConvertFrom-Json
    $result
}
```

需要安装或卸载时，将 `$arguments` 中的 `--status` 分别替换为 `--install` 或 `--uninstall`。

## 4. 返回结果结构

命令返回 UTF-8 编码的 JSON 对象。下面是一次“未发现设备”的状态查询结果示例：

```json
{
  "version": 1,
  "action": "status",
  "outcome": "success",
  "exitCode": 0,
  "rebootRequired": false,
  "stateKnown": true,
  "installationState": "absent",
  "message": "未发现设备实例。",
  "warning": "",
  "log": "",
  "stateError": ""
}
```

### 字段说明

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `version` | 整数 | 结果格式版本，当前为 `1`，不是驱动版本 |
| `action` | 字符串 | `status`、`install`、`uninstall`、`help`；参数错误时为 `arguments` |
| `outcome` | 字符串 | 本次命令的执行结果，取值见下表 |
| `exitCode` | 32 位有符号整数 | 本次命令的返回码，常见取值见第 5 节 |
| `rebootRequired` | 布尔值 | 是否需要重启 Windows |
| `stateKnown` | 布尔值 | 是否成功获取设备状态 |
| `installationState` | 字符串 | `absent`、`device_present` 或 `unknown` |
| `message` | 字符串 | 结果说明或错误信息 |
| `warning` | 字符串 | 未完成项或需要关注的信息；没有时为空字符串 |
| `log` | 字符串 | 本次操作的日志；没有时为空字符串 |
| `stateError` | 字符串 | 安装或卸载后查询状态失败的原因；没有时为空字符串 |

使用命令别名时，`action` 仍返回主命令名称，例如 `--list` 返回 `status`。

| `outcome` | 含义 |
| --- | --- |
| `success` | 命令执行成功 |
| `reboot_required` | 操作已提交，需要重启 Windows 才能完成 |
| `incomplete` | 存在未完成项，请查看 `warning` 和 `log` |
| `failed` | 命令执行失败，请查看 `exitCode` 和 `message` |

| `installationState` | 含义 |
| --- | --- |
| `absent` | 未发现虚拟麦克风设备实例 |
| `device_present` | 存在虚拟麦克风设备实例，包括隐藏设备；不等同于设备当前可用 |
| `unknown` | 未查询设备状态，或未能确认状态 |

帮助命令不查询设备状态，因此返回 `stateKnown=false`、`installationState=unknown`。

安装或卸载后的状态查询失败时，原操作结果仍保留，设备状态返回 `unknown`，原因放在 `stateError`。请结合 `outcome` 和退出码判断操作结果，不要只依据设备状态判断成功或失败。

### C++ 结果结构体示例

调用方可使用以下结构体接收 JSON 解析后的字段，字符串内容为 UTF-8：

```cpp
#include <cstdint>
#include <string>

struct InstallerCommandResult {
    std::uint32_t version;
    std::string action;
    std::string outcome;
    std::int32_t exitCode;
    bool rebootRequired;
    bool stateKnown;
    std::string installationState;
    std::string message;
    std::string warning;
    std::string log;
    std::string stateError;
};
```

## 5. 退出码与结果处理

| 退出码 | 含义 | 处理方式 |
| --- | --- | --- |
| `0` | 成功 | 读取返回结果 |
| `13` | 驱动包数据无效，包括 Release 包缺少数字签名 | 使用完整且已签名的驱动包后重试 |
| `29` | 结果输出失败 | 检查输出目录权限，使用尚不存在的新文件名 |
| `87` | 参数错误 | 检查命令格式，每次只指定一个命令 |
| `170` | 另一个安装器正在操作驱动 | 等待当前操作结束后重试 |
| `299` | 存在未完成项 | 查看 `warning`、`log` 和 `message` |
| `1223` | 取消管理员权限授权 | 需要执行操作时重新运行并允许授权 |
| `3010` | 需要重启 | 保存工作后重启 Windows |

其他非零退出码请结合 `message` 查看具体原因；部分 Windows 错误码可能显示为负数。

输出失败时可能没有完整的 JSON 文件，应检查进程退出码。若操作已执行，但结果输出失败，请先查询状态，再决定后续操作。
