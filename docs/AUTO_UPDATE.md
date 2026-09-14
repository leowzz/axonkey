# 应用自动更新

桌面应用启动、恢复前台或联网时通过 Tauri Updater 检查 GitHub Releases 的 `latest.json`，成功检查间隔一小时，失败一分钟后可重试。发现新版仅提示，用户可继续使用当前版本；只有在「关于」页点击「更新并重启」后才会下载、安装并重启，期间显示下载进度。失败可重试或手动下载。浏览器预览仍使用 GitHub 版本查询，调试预览不允许执行安装。

## 发布

标签构建生成 Windows NSIS 安装包及签名、macOS universal `Axonkey.app.tar.gz` 及签名。两个 Mac 架构使用同一个 universal 更新包。发布任务验证产物后生成 `latest.json`，上传完整产物再将草稿发布，避免客户端读到尚未上传的包。

更新签名公钥在 `src-tauri/tauri.conf.json`；私钥保存在未纳入 Git 的 `secrets/tauri-updater.key`，并通过 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` 提供给构建。当前私钥无口令，`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 留空。妥善备份私钥；已安装客户端绑定此公钥，不应随意重新生成。

普通本地构建无需签名密钥。需要本地生成更新产物时：

```sh
export TAURI_SIGNING_PRIVATE_KEY="$PWD/secrets/tauri-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
node scripts/build-macos.mjs --target universal-apple-darwin --bundles app,dmg --config src-tauri/tauri.updater.conf.json
```

`tauri.updater.conf.json` 仅开启更新产物，CI 会自动合并此配置。更新签名独立于 Apple 代码签名和公证。macOS 更新替换应用包，系统虚拟麦克风驱动仍通过现有驱动安装流程管理。

首个包含自动更新功能的版本仍需用户手动安装；发布后续版本才能实际验证跨版本自动更新。发布验证应覆盖 Windows 与 Intel/Apple Silicon Mac，从已安装的旧版检查、下载、安装、重启，并验证用户配置保留。
