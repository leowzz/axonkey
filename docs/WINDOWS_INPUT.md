# Windows 输入

Axonkey 在 Windows 11 x64 上使用 `QuarborUniversalKeyboardDriver` 处理 RC003 按键映射。驱动属于设备实例：添加 RC003 后，在该实例的设备工作区完成安装和状态检查。卸载时使用保存的原驱动信息恢复设备，即使设备暂时离线也会保留恢复记录。

[返回首页](../README.md) · [首次使用](USAGE.md#windows)

## 输入链路

Quarbor Universal 只安装到 RC003 的 `BTHLEDEVICE` 父设备实例，不注册全局 Keyboard 类过滤器。驱动通过 `\\.\pipe\Quarbor.UniversalKeyboard.v1.<16 位实例哈希>` 提供 Protobuf 字节流。Rust 后端用 Tokio 双工连接管道，通过 `prost` 解码 `Hello → BasicInfo → PhysicalReport/InputResult/InputStatus`；帧使用 4 字节小端长度前缀，连接后先查询基础信息。构建使用 `protox` + `prost-build` 从 `SDK/keyboard.proto` 生成 Rust 类型，无 C++ 桥接或 nanopb 联编。

普通键盘不会进入 RC003 映射流程。管道客户端使用 `SECURITY_IDENTIFICATION`，以读写权限连接当前设备对应的本机管道；设备重新枚举后，客户端会按新的实例 ID 重连。

当前读取原始报告，按 RC003 的 Report ID 和小端 16 位 usage 槽直接解码，更新 13 个按键的按下/松开状态，支持编辑器提供的全部遥控器动作和延时序列。遥控器驱动来源的标准键盘、Consumer 媒体控制和支持的三键鼠标动作优先通过 Universal 驱动的 `keysend` / `mouse_move` 回写；驱动能力缺失或连接不可用时，回退到对应的 `SendInput` 软件实现。Windows 鼠标服务来源的映射动作（包括键盘快捷键和 XBUTTON）全部使用 `SendInput`，因此鼠标用户无需安装 Universal 驱动。打开应用／网站沿用系统启动接口及目标校验。完整调用和验证方式见 [Universal 接入说明](quarbor-v3-read.md)。

Windows 支持 13 个可配置按键。RC003 已知 HID usage 包括确认 `0x28`、TV `0x35`、语音 `0x3E`、主页 `0x4A`、方向 `0x4F/0x50/0x51/0x52`、菜单 `0x65`、电源 `0x66`、返回 `0xF1` 和音量 `0x80/0x81`。驱动报告保留 Report ID 和原始字节，客户端只对已知 RC003 usage 生成按键边沿。

返回键和音量 `+ / -` 与其他 RC003 按键一样，由 Quarbor HID 报告直接解析，不需要单独开启功能或额外授权。映射页对这三个按键使用与其他按键相同的行为编辑器。

## 安装与语音

设备工作区直接运行随包提供的 `QuarborUniversalKeyboardDriverInstaller.exe`：`--list` 以普通权限查询设备，安装使用当前实例对应的 `--install <instanceId>`，由安装器自行请求 UAC。由于安装器是 GUI 子系统程序，应用按 SDK 约定通过唯一临时 JSON 文件读取结果，不依赖 stdout。实例运行时只连接自己匹配的 Quarbor 节点；状态查询使用 JSON 的 `bound` / `recoveryActive` 字段，操作按退出码和 `rebootRequired` 提示重启，取消 UAC 单独显示。接口见 [Quarbor 安装器 CLI 文档](../vendor/QuarborUniversalKeyboardDriverInstaller/SDK/INSTALL_USER_MANUAL.md)。

RC003 语音由独立 Bluetooth GATT 链路处理。需要语音时安装 VB-CABLE；Axonkey 解码音频并输出到 `CABLE Input`，录音应用选择 `CABLE Output`。

## 从旧版迁移

Windows 启动时不再执行全局 Quarbor 驱动升级或全局状态检查。进入缺少驱动的 RC003 设备工作区后，页面显示该实例的安装引导；安装结束后重新读取该实例的节点状态。

旧版 Interception 驱动和 AxonkeyInterceptionFix 重连修复服务不再参与输入链路，也不会随新版本安装。启动时检测到旧组件会先显示清理步骤；清理完成后，回到对应 RC003 设备工作区安装 Quarbor 驱动。

旧版本的问题记录保留在 [Interception 重连问题说明](./INTERCEPTION_HOTPLUG_INCIDENT.md)，仅供历史排查参考。

## 故障排查

若设备已连接但按键没有响应，请查询安装器 `--list`，确认 RC003 的 `present` 和 `bound` 状态，并重新连接 RC003。运行日志与驱动操作日志统一位于 `%LOCALAPPDATA%\com.axonkey.app\logs`，可从首页“运行日志”打开。驱动日志包含安装器命令、退出码及 JSON 输出；音频字段说明见 [运行日志](TROUBLESHOOTING.md#运行日志)。

## 手动安装驱动

也可以直接使用安装器 CLI。以下命令在包含 `vendor` 的目录（如仓库根目录或解压后的发行目录）中执行；GUI 子系统安装器的查询结果通过 `--output` 文件读取：

```powershell
$installer = '.\vendor\QuarborUniversalKeyboardDriverInstaller\QuarborUniversalKeyboardDriverInstaller.exe'
$listPath = Join-Path $env:TEMP ('axonkey-quarbor-list-' + [guid]::NewGuid().ToString('N') + '.json')
$listProcess = Start-Process -FilePath $installer -ArgumentList @('--list', '--output', $listPath) -Wait -PassThru
$devices = Get-Content -LiteralPath $listPath -Raw | ConvertFrom-Json
# 将下方字符串替换为 --list 中 RC003 的 instanceId。
$rc003Id = 'RC003 的完整设备实例 ID'
& $installer --install $rc003Id
```

查询不请求管理员权限；安装器在安装、卸载时自行申请 UAC，并管理驱动包和设备恢复记录。应用安装只对当前 RC003 实例对应的设备节点执行操作。退出码 `3010` 表示需要重启，`1223` 表示取消授权。完整说明见 [安装器 CLI 文档](../vendor/QuarborUniversalKeyboardDriverInstaller/SDK/INSTALL_USER_MANUAL.md)。

在仓库根目录也可以手动启动经过校验的 VB-CABLE 安装流程：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\vbcable-driver.ps1 -Action install
```

该脚本校验未修改的官方 Pack45 ZIP、x64 安装器哈希和发布者签名，随后申请管理员权限并打开 VB-Audio 官方安装窗口。安装完成后需要重启 Windows，录音设备列表中会出现 `CABLE Output (VB-Audio Virtual Cable)`。

## 卸载输入驱动

先退出 Axonkey 和其他使用 Quarbor 驱动的工具，再在包含 `vendor` 的目录中运行：

```powershell
$installer = '.\vendor\QuarborUniversalKeyboardDriverInstaller\QuarborUniversalKeyboardDriverInstaller.exe'
$listPath = Join-Path $env:TEMP ('axonkey-quarbor-list-' + [guid]::NewGuid().ToString('N') + '.json')
$null = Start-Process -FilePath $installer -ArgumentList @('--list', '--output', $listPath) -Wait -PassThru
$devices = Get-Content -LiteralPath $listPath -Raw | ConvertFrom-Json
$rc003Id = 'RC003 的完整设备实例 ID（可以离线）'
& $installer --uninstall $rc003Id
```

安装器会申请管理员权限，并返回是否需要重启 Windows。也可以运行 `make uninstall-driver DEVICE="设备实例 ID"`，只处理指定设备。
