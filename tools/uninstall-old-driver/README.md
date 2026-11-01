# uninstall-old-driver

独立的 Windows C++ 桌面卸载工具。Visual Studio 打开
`uninstall-old-driver.sln`，选择 `Release | x64` 构建；构建后通过仓库脚本将
`bin\Release\uninstall-old-driver.exe` 复制到仓库根目录的 `scripts` 目录。

构建要求开发机安装 Visual Studio 的“使用 C++ 的桌面开发”工作负载、MSVC v145
工具集和 Windows SDK。仓库脚本通过 `vswhere` 或 PATH 定位 MSBuild，重新构建
`Release | x64`；缺少工具或构建失败时直接报错。

Visual Studio 使用 `/MT`（Debug 为 `/MTd`）静态链接编译器运行库，
只保留 Windows 10/11 自带系统 DLL 的动态依赖，无需额外分发 VC++ 运行库 DLL。

原 Rust 实现已迁移到 `tools/uninstall-old-driver-rust` 作为历史备份，当前项目使用
Win32 API 绘制窗口、执行服务和驱动清理，并通过 UTF-8 输出状态信息。

Tauri 构建和 GitHub CI 均不编译这个子项目，直接打包 Git 中已提交的
`scripts\uninstall-old-driver.exe`。修改工具源码后，请在本地运行仓库根目录的
`npm run build:uninstall-old-driver`，并将更新后的 exe 与源码一起提交后再发布。

直接双击打开会显示“开始卸载”按钮。Tauri 使用 `--confirmed --headless --log-path PATH`
执行清理，由应用内独立弹窗显示结果、失败重试和重启提醒。管理员授权仍使用系统 UAC。
手动使用 `--auto-close` 时，工具窗口在成功后约 0.8 秒关闭，失败或超时保留窗口。
`--status` 只输出检测结果，不显示窗口或触发卸载。

提交或排查仓库布局时运行 `npm run check:uninstall-old-driver-git`；它会检查 VC
项目文件、已跟踪的 Tauri 资源、生成目录忽略规则，以及旧 Rust 路径是否残留。

## VB-CABLE 独立命令

VB-CABLE 卸载由本项目原生实现，替代原 `legacy-audio-cleanup.ps1`，无需
PowerShell、PnPUtil 或旧版 VB-CABLE 安装器。以下命令在仓库根目录运行：

```powershell
# 只检查标准版 VB-CABLE 设备（包括隐藏设备），不提权、不写日志
& .\scripts\uninstall-old-driver.exe --vbcable-status

# 预览本次清理的设备、OEM 驱动包和文件，不修改系统、不提权
& .\scripts\uninstall-old-driver.exe --uninstall-vbcable --dry-run

# 卸载并清理；需要时申请 UAC 管理员授权，不打开本工具 GUI
& .\scripts\uninstall-old-driver.exe --uninstall-vbcable --confirmed
```

新增命令不接入本工具原有 GUI、`--status` 和默认输入驱动清理流程。
应用原有虚拟声卡升级窗口保持不变，其后端改为调用上述独立命令。

清理范围为标准版 VB-CABLE：

- 精确匹配硬件 ID `VBAudioVACWDM` 的所有设备节点，通过 `DiUninstallDevice`
  删除设备及子端点，包括隐藏设备。
- 扫描 Windows INF 目录中的全部 `oemN.inf`，使用 SetupAPI 解析并同时核对
  `HardwareId=VBAudioVACWDM` 和 `ServiceName=VBAudioVACMME`；通过
  `DiUninstallDriverW` 删除所有匹配包，包含未绑定设备的历史包及其 Driver Store 文件。
- 清理 `VBAudioVACMME` 服务、旧版遗留在系统 drivers 目录中的已知驱动文件、
  System32 / SysWOW64 中的 `VBCABLE_ControlPanel.exe`。
- 清理 Windows 的 64 / 32 位 Program Files 下标准安装目录 `VB\CABLE` 及其内容；
  不清理下载目录或其他 VB-Audio 产品目录。
- 同时清理应用目录内旧的 `vendor\vbcable` 目录及其内容；以发布到 `scripts` 的
  EXE 所在目录的上一级为应用目录，不依赖命令运行时的工作目录。目录不存在则跳过，
  不删除其他 vendor 内容；`--dry-run` 同样列出这些文件和目录。
- 清理标准版已知的五个 MediaCategories 注册表项，以及 32 / 64 位视图下
  `SOFTWARE\VB-Audio\Cable` 和准确的 VB-CABLE 卸载注册项。

不匹配 Cable A/B/C/D、Hi-Fi Cable、VoiceMeeter 或 Quarbor。设备或驱动包卸载失败时，
保留其余文件及设置并报告失败，不手工破坏 Driver Store。单项错误写入日志和 JSON，
不会返回“成功”。不添加卸载后的复查、开机任务或持久化复查状态。

被占用的文件会通过 Windows API 安排在重启时删除；需要重启时返回
`rebootRequired: true` 和退出码 **3010**，提示用户重启，不自动重启。
退出码 **0** 表示成功，**1** 表示失败，**2** 表示参数错误，**1223** 表示取消 UAC。
多个 API 的重启要求会累计保留，即使后续步骤失败也不会丢失。

默认日志为 `%LOCALAPPDATA%\com.axonkey.app\logs\vbcable-uninstall.log`。
支持 `--log-path PATH` 指定日志、`--result-path PATH` 将 UTF-8 JSON 写入文件。
提权后进程的 stdout 不保证继承，程序调用卸载命令时应使用结果文件和退出码。
JSON 的 `installed` 仅在 `--vbcable-status` 时为布尔值；卸载不进行复查，返回 `null`。

原生 INF 选择测试使用同一 MSBuild 工具链编译并执行真实的 SetupAPI 解析：

```powershell
node scripts/build-uninstall-old-driver.mjs --test
node --test test/legacy-audio-cleanup.test.mjs test/legacy-cleanup-script.test.mjs
```

测试仅进行临时 INF 解析、状态查询和清理预览，不执行本机驱动卸载。
API 行为参见 [DiUninstallDevice](https://learn.microsoft.com/en-us/windows/win32/api/newdev/nf-newdev-diuninstalldevice)
和 [DiUninstallDriverW](https://learn.microsoft.com/en-us/windows/win32/api/newdev/nf-newdev-diuninstalldriverw)。
