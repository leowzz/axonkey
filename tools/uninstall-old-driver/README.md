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

直接双击打开会显示“开始卸载”按钮。Tauri 使用 `--confirmed --auto-close --log-path PATH`
打开进度窗口并自动开始卸载；成功后显示完成状态约 0.8 秒，然后自动关闭。失败或超时
时保留窗口，便于查看错误和日志。显式传入 `--headless` 时仍可无窗口执行；`--status`
只输出检测结果，不显示窗口或触发卸载。

提交或排查仓库布局时运行 `npm run check:uninstall-old-driver-git`；它会检查 VC
项目文件、已跟踪的 Tauri 资源、生成目录忽略规则，以及旧 Rust 路径是否残留。
