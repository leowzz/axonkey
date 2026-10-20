# uninstall-old-driver

独立的 Windows C++ 桌面卸载工具。Visual Studio 打开
`uninstall-old-driver.sln`，选择 `Release | x64` 构建；构建后通过仓库脚本将
`bin\Release\uninstall-old-driver.exe` 复制到仓库根目录的 `scripts` 目录。

仓库脚本优先调用 MSBuild；开发机没有 v145 工具集时会使用同一源码的 CMake/Ninja
fallback 进行验证。

原 Rust 实现已迁移到 `tools/uninstall-old-driver-rust` 作为历史备份，当前项目使用
Win32 API 绘制窗口、执行服务和驱动清理，并通过 UTF-8 输出状态信息。

Tauri 构建不会编译这个子项目，只会打包已经存在的
`scripts\uninstall-old-driver.exe`。发布前请先运行仓库根目录的
`npm run build:uninstall-old-driver`。

直接双击打开会显示“开始卸载”按钮。Tauri 使用 `--confirmed --auto-close --log-path PATH`
打开进度窗口并自动开始卸载；成功后显示完成状态约 0.8 秒，然后自动关闭。失败或超时
时保留窗口，便于查看错误和日志。显式传入 `--headless` 时仍可无窗口执行；`--status`
只输出检测结果，不显示窗口或触发卸载。

提交或排查仓库布局时运行 `npm run check:uninstall-old-driver-git`；它会检查 VC
项目文件、已跟踪的 Tauri 资源、生成目录忽略规则，以及旧 Rust 路径是否残留。
