# 应用自动更新

[返回首页](../README.md) · [开发与发布](DEVELOPMENT.md)

桌面应用启动、恢复前台或联网时检查当前主版本的更新，成功检查间隔一小时，失败一分钟后可重试。发现新版仅提示；只有在“关于”页点击“更新并重启”后才会下载、安装并重启，期间显示下载进度。失败可重试或手动下载。浏览器预览读取同一主版本清单，不执行安装。

## 版本范围与更新清单

仅正式版附带 `latest.json`。CI 在正式 Release 发布成功后，将清单同步到独立的 `updates` 分支。
应用直接读取当前主版本的固定文件，不调用 GitHub Release 列表 API：

```text
v0: https://raw.githubusercontent.com/leowzz/axonkey/updates/v0/latest.json
v1: https://raw.githubusercontent.com/leowzz/axonkey/updates/v1/latest.json
```

清单里的安装包地址仍指向对应正式 Release，沿用签名校验。CI 自动创建和维护 `updates` 分支，
预发布不更新清单，补发旧版本不会覆盖较新版本；并发发布会重试合并各主版本的清单。
固定地址在首次正式发版后生效，清单不可用时会显示检查失败。
`v0.x.x` 只检查和更新到 `v0.x.x`，`v1.x.x` 只检查和更新到 `v1.x.x`。
自动检查和“检查更新”均不提示跨主版本更新；跨主版本只能通过“前往下载”手动下载安装。
预发布之间需手动安装，同主版本的预发布可更新到较新的正式版。
应用及官网的手动下载入口指向完整 Release 列表，可选择需要的主版本。
各版本共用应用标识及配置目录，手动安装时会覆盖已有应用。

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

不含自动更新功能的旧版需先手动安装新版。发布验证应覆盖 Windows 与 Intel/Apple Silicon Mac，从已安装的旧版检查、下载、安装、重启，并验证用户配置保留。
