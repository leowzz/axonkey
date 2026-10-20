# 开发与发布

[返回首页](../README.md)

## 本地开发

开发环境需要 Node.js 与 Rust stable。Windows 还需要 MSVC 构建工具和 WebView2；macOS 开发应用需要 Xcode Command Line Tools，构建 MiRemoteV 驱动和发布包需要完整 Xcode。

以下命令均在仓库根目录执行。macOS 中安装依赖并启动桌面应用：

```bash
cp .env.example .env
npm install
npm run tauri dev
```

Windows PowerShell 使用 `Copy-Item .env.example .env` 创建本地版本文件，其余命令相同。

`.env` 是本机版本来源并被 Git 忽略，只允许包含一行 `version=vX.Y.Z`（可附加 `-alpha.N`、`-beta.N` 或 `-rc.N`，N 为正整数）。首次检出时从已提交的 `.env.example` 复制；`make release` 会同时更新本地 `.env`、`.env.example` 和各框架清单中的版本。

检查前端生产构建和 Rust 测试：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Make 命令

项目也提供 Makefile：

```bash
make dev
make build
make build-macos-audio
make build-macos
make test-release
make release
make release V=v0.1.25
```

## 版本与发布

`make release` 要求 Git 工作区完全干净。未传 `V` 时，它从 `.env` 递增 patch；也可以用 `V=vX.Y.Z` 指定版本。命令会同步 `.env.example`、npm、Cargo 和 Tauri 版本，创建 `chore: release vX.Y.Z` 提交，再在该提交上创建 annotated tag。它不会构建、推送或发布远端 Release。

预发布沿用同一套发版和构建流程：

```bash
make release V=v1.2.3-beta.1
make release RC=1          # 当前为 v0.2.29 或 v0.2.29-alpha.1 时，生成 v0.2.30-rc.1
make release V=0.2.30 RC=3 # 生成 v0.2.30-rc.3（V 也可带 v 前缀）
# 后续显式指定 beta.2、rc.1，或正式版 v1.2.3
```

推送 `v*` tag 后，CI 先校验版本和远端分支归属，再运行测试并构建 Windows NSIS、macOS Universal 安装包。
预发布使用相同的签名、公证配置，发布为 GitHub Pre-release，不占用 Latest；正式版发布为 Release。
为兼容仍查询全局 Latest 的旧客户端，只有 `v0.x.x` 正式版标记为 Latest；`v1.x.x` 及后续主版本不占用 Latest。
当前为预发布版本时，必须显式传入 `V` 或 `RC`；两者均不传时会拒绝执行。正式版不传两者仍递增 patch。
`RC=N` 要求 N 为无前导零的正整数；不传 `V` 时，去掉当前预发布后缀并递增 patch，再追加 `-rc.N`。
同时传入 `V` 和 `RC` 时直接使用指定基础版本（支持带或不带 `v` 前缀），此时 `V` 不能附带预发布后缀。
版本顺序为 `alpha.N < beta.N < rc.N < 正式版`，不接受低于当前版本的发版请求。

更新清单、主版本隔离和签名配置见 [自动更新](AUTO_UPDATE.md)。

## 安装包

`make build` 只校验 `.env` 与 npm、Cargo、Tauri
版本一致，然后根据当前平台构建安装包，不修改版本文件或 Git 状态。Windows 生成 NSIS 安装程序，macOS 生成 DMG：

```text
Windows: src-tauri\target\release\bundle\nsis\Axonkey_<version>_x64-setup.exe
macOS:   src-tauri/target/release/bundle/dmg/Axonkey_<version>_<arch>.dmg
```

Windows 安装包使用 `src-tauri/windows/installer.nsi` 自定义模板：已有 NSIS 安装直接覆盖，
升级或同版本重装时不再显示“先卸载 / 不卸载”选择页，也不会调用旧版卸载程序。
安装目录恢复、运行中程序检查和独立卸载入口仍由 Tauri 模板处理；WiX/MSI 迁移保留原有流程。
卸载 Axonkey 时，会先调用随包驱动安装器的 `--uninstall-all` 并等待结束，再继续删除软件；无论驱动卸载成功、失败或取消授权，均不阻止软件卸载。
模板基于 `tauri-cli-v2.11.4`，升级 Tauri CLI 时需同步检查上游模板变更。

`make build-macos` 使用同一版本校验，并生成当前架构的 `.app` 与 `.dmg`：

```text
src-tauri/target/release/bundle/macos/Axonkey.app
src-tauri/target/release/bundle/dmg/Axonkey_<version>_<arch>.dmg
```

`make build-macos-audio` 可单独从固定的 BlackHole 源码构建 MiRemoteV 驱动及安装、卸载 PKG；`make build` 和 `make build-macos` 在 macOS 上会自动执行这一步。

## macOS 签名与公证

设置 `APPLE_SIGNING_IDENTITY` 后，`make build-macos` 会用该证书签名 App 和 DMG；此时还需通过 `MACOS_INSTALLER_SIGNING_IDENTITY` 指定钥匙串中的安装包签名证书，否则构建会拒绝嵌入未签名的 MiRemoteV PKG。构建流程支持自签名证书和 Developer ID 证书。两项 identity 都不设置时，App 使用 ad-hoc 签名，MiRemoteV PKG 不签名。输入监控和辅助功能权限绑定代码签名身份，经常安装本地构建时应固定使用同一签名证书。ad-hoc 构建每次变化后都可能需要移除旧权限条目并重新授权。

自签名分发包的首次安装与授权步骤见 [macOS 启动与授权排查](TROUBLESHOOTING.md#macos-无法打开应用或驱动安装包)。使用 Developer ID 签名并配置 Apple 公证凭据时，CI 会执行公证流程。

发布者应长期保留同一套自签名证书和私钥；丢失或重新生成证书后，macOS 会将后续构建视为新的应用身份。

架构与协议参考：[架构说明](ARCHITECTURE.md) · [产品范围](PRODUCT.md) · [Windows 输入](WINDOWS_INPUT.md)。
