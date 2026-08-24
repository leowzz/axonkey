# OpenInputBridge Windows 交割文档

- 交割日期：2026-08-24
- 仓库：`/Users/leo/work/axonkey`
- 当前分支：`feat/mac`
- 当前状态：OpenInputBridge 代码已实现但尚未提交；Windows + RC003 验收未执行
- 配套方案：[Axonkey Windows OpenInputBridge 迁移方案](./OPENINPUTBRIDGE_MIGRATION_PLAN.md)

## 1. 接手时先读

当前工作树不是干净状态，并混有用户正在进行的 macOS 工作。切换机器或准备提交时不要执行 `git add .`，也不要回退不属于本次迁移的内容。

已知非本任务改动：

- `src-tauri/native/macos_input.m`
- `src-tauri/src/input_service/macos.rs`
- `debug/modifier_hold_probe.m`（未跟踪）

`docs/WINDOWS_INPUT_ALTERNATIVES.md` 是此前完成的调研成果，当前也处于修改状态，应保留。

本次迁移当前没有 commit。若 Windows 电脑使用另一个 clone，必须先通过经过审阅的 scoped commit、patch 或其他安全方式传递这些改动。不要用包含上述 macOS 文件的整仓 stash/commit 代替范围审查。

## 2. 已完成文件

### 核心实现

- `src-tauri/src/input_service/windows.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`

### 安装与打包

- `scripts/openinputbridge-driver.ps1`（新增）
- `scripts/openinputbridge-package.mjs`（新增）
- `test/openinputbridge-package.test.mjs`（新增）
- `scripts/build.mjs`
- `src-tauri/tauri.windows.conf.json`
- `Makefile`
- `package.json`
- `scripts/install-driver.ps1`（删除）
- `scripts/uninstall-driver.ps1`（删除）
- `vendor/openinputbridge/SOURCE.md`（新增）
- `vendor/openinputbridge/LICENSE-MIT.txt`（新增）

### UI 与文档

- `src/App.tsx`
- `src/setupModel.ts`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/PRODUCT.md`
- `docs/OPENINPUTBRIDGE_MIGRATION_PLAN.md`（新增）
- `docs/OPENINPUTBRIDGE_WINDOWS_HANDOFF.md`（新增）
- `THIRD_PARTY_NOTICES.md`

## 3. 当前验证边界

已在 macOS 主机基于当前交割工作树完成：

- Rust 全量 22 个测试通过；
- `x86_64-pc-windows-msvc` cross `cargo check` 通过，无源码错误；
- release/package contract 16 个测试通过；
- TypeScript/Vite production build 通过；
- PowerShell 脚本通过 PowerShell 7 AST parse；
- `git diff --check` 通过；
- OIB package 缺失时 release preflight 按设计失败。

Windows cross-check 仍显示 5 个既有的 macOS-only dead-code warning，不是 OIB 编译错误。这些结果只证明源码和静态契约，不证明 Windows 驱动能安装，也不证明 RC003 断连问题已经在真机解决。接手前应根据最新工作树重新运行第 6 节命令，以 Windows 原生输出为准。

## 4. 当前外部阻塞

仓库没有付费的 OpenInputBridge WHQL binary。Windows release 会故意失败，直到以下文件全部放入 `vendor/openinputbridge/`：

```text
OpenInputBridgeSetup.exe
oib_kbd/oib_kbd.inf
oib_kbd/oib_kbd.cat
oib_kbd/oib_kbd.sys
oib_mou/oib_mou.inf
oib_mou/oib_mou.cat
oib_mou/oib_mou.sys
```

拿到 package 后先完成两项人工确认：

1. Applet LLC 明确允许把该 WHQL binary 随 Axonkey 再分发；
2. 实际 installer/catalog signer 与脚本的 publisher pattern 一致。

当前脚本假设：

- installer signer subject 匹配 `*Applet LLC*`；
- keyboard/mouse catalog signer 匹配 `*Microsoft Windows Hardware Compatibility Publisher*`。

这是失败关闭的占位安全策略，不是已用真实付费包验证过的事实。若真实签名名称不同，应先核对证书链和 vendor 说明，再精确修改 pattern，不能为了通过而删除签名校验。

## 5. Windows 环境准备

建议使用隔离测试机或可恢复系统镜像，准备：

- Windows 11 x64，Secure Boot 开启；
- Memory Integrity 开启和关闭各一轮；
- Visual Studio Build Tools 的 Desktop development with C++；
- Rust MSVC stable toolchain；
- Node.js/npm；
- WebView2 runtime；
- PowerShell 5.1 或 7；
- RC003 和一把独立普通键盘；
- 已授权的完整 OIB WHQL package；
- 管理员权限和可访问的恢复环境。

第一轮不要在唯一的日常工作机上测试 filter driver，也不要同时保留 Interception。

## 6. 接手执行顺序

所有命令从仓库根目录执行；仓库指令要求 shell 命令使用 `rtk` 前缀。

### Step 1：确认工作树和改动范围

```powershell
rtk git status --short
rtk git diff --check
rtk git diff -- src-tauri/src/input_service/windows.rs scripts/openinputbridge-driver.ps1 src-tauri/tauri.windows.conf.json
```

确认没有覆盖第 1 节列出的 macOS 改动。

### Step 2：安装依赖并跑静态测试

```powershell
rtk npm install
rtk npm run test:release
rtk npm run build
rtk cargo fmt --manifest-path src-tauri/Cargo.toml --check
rtk cargo test --manifest-path src-tauri/Cargo.toml input_service::windows::tests
rtk cargo test --manifest-path src-tauri/Cargo.toml
rtk cargo check --manifest-path src-tauri/Cargo.toml
```

预期：所有命令通过；Windows backend 测试包含 OIB identity、wire contract、动态槽位和 RC003 重新选择。

### Step 3：放入并审计 OIB package

按第 4 节目录放置文件，保留 vendor 附带的 license/readme。记录：

```powershell
Get-ChildItem -Recurse .\vendor\openinputbridge | Get-FileHash -Algorithm SHA256
Get-AuthenticodeSignature .\vendor\openinputbridge\OpenInputBridgeSetup.exe | Format-List Status,StatusMessage,SignerCertificate
Get-AuthenticodeSignature .\vendor\openinputbridge\oib_kbd\oib_kbd.cat | Format-List Status,StatusMessage,SignerCertificate
Get-AuthenticodeSignature .\vendor\openinputbridge\oib_mou\oib_mou.cat | Format-List Status,StatusMessage,SignerCertificate
```

将批准版本、SHA-256、签名主体、授权文件位置写回 `vendor/openinputbridge/SOURCE.md`。

### Step 4：构建 NSIS

准备与现有发布流程一致的 `.env` 后执行：

```powershell
rtk npm run test:release
rtk make build
```

检查：

- 生成 `Axonkey_<version>_x64-setup.exe`；
- 构建输出记录 installer SHA-256；
- NSIS 包含 OIB package、新 PowerShell 脚本和 third-party notice；
- NSIS 不含 `interception.dll`、旧 installer 或旧 driver binary。

### Step 5：清理旧 Interception

若 `%WINDIR%\System32\drivers\keyboard.sys` 或 `mouse.sys` 存在：

1. 使用旧 Interception 官方 installer `/uninstall`；
2. 重启；
3. 确认两个旧文件和对应 filter registration 已消失；
4. 不要在同一次启动周期继续安装 OIB。

### Step 6：安装 OpenInputBridge

可通过 Axonkey 设置向导，或直接运行：

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\openinputbridge-driver.ps1 -Action Install
```

脚本应：

- 验证 package 完整性和签名；
- 请求明确输入 `INSTALL`；
- 请求 UAC；
- 调用 vendor installer；
- 启用 audit log 和 toast；
- 执行 `--verify-install`；
- 要求重启。

安装日志默认位于 `%LOCALAPPDATA%\Axonkey\logs\driver-install.log`。

### Step 7：重启后做最小 smoke test

1. 普通键盘输入正常；
2. Axonkey 显示 OIB backend ready；
3. RC003 hardware ID 匹配 `VID_2717&PID_32B8`；
4. 只启用一个易观察映射；
5. RC003 原键被覆盖，映射键到达；
6. 普通键盘同键不受影响；
7. 禁用映射和退出 Axonkey 后，RC003 恢复原键透传；
8. OIB audit/toast 只显示预期的 Axonkey access。

任一步失败都先停止压力测试并保留证据。

### Step 8：执行断连回归

先做 10 次短循环，稳定后再执行完整矩阵：

1. 触发 RC003 idle 断开；
2. 按键唤醒/重连；
3. 记录旧/新 device instance、hardware ID 和 OIB slot；
4. 验证映射实际到达；
5. 同时验证普通键盘不受影响；
6. 退出 Axonkey，验证 RC003 后续输入透传；
7. 重启 Axonkey并进入下一轮。

完整门槛见迁移方案第 7 节。任何一次出现“所有输入失效且只能重启恢复”，立即判定 No-Go，保存 crash dump、Axonkey 日志、OIB audit、Event Viewer 和 SetupAPI 日志。

## 7. 重点观察的代码风险

1. **PnP slot 竞态**：RC003 离线时另一键盘占用槽位，Axonkey 必须重建 context 并按 hardware ID 重新选择，不能过滤普通键盘。
2. **进程冻结**：OIB file-close cleanup 能覆盖退出/崩溃，但无法覆盖仍持有句柄的永久挂死。必须单列冻结测试。
3. **I/O 错误重建**：wait/read 返回错误后 worker 应销毁 context，再走稳定设备等待与重新枚举。
4. **签名主体假设**：用真实 package 确认脚本的 publisher pattern。
5. **Windows 10**：上游正式支持边界不明确，结果必须与 Windows 11 分开记录。
6. **全局控制接口**：OIB 是全键鼠 class filter，audit/toast 和 OEM 安全边界必须纳入发布决定。

## 8. 取证清单

每次失败至少保存：

- `%LOCALAPPDATA%\Axonkey\logs\driver-install.log` 或 `driver-uninstall.log`；
- Axonkey 应用日志和具体时间戳；
- OIB audit log/toast 截图或导出；
- Event Viewer 的 System/Application 相关事件；
- `%WINDIR%\INF\setupapi.dev.log` 对应时间段；
- Device Manager 中 RC003 keyboard TLC 的 instance path、driver stack 和 filters；
- OIB package 版本、SHA-256、签名主体；
- 复现步骤、循环次数、是否能通过退出应用恢复、是否必须重启。

不要只记录“蓝牙已连接”或“设备管理器正常”。核心证据是实际输入是否透传/映射，以及 context 销毁后过滤是否解除。

## 9. 卸载与恢复

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\openinputbridge-driver.ps1 -Action Uninstall
```

输入 `UNINSTALL`，等待 vendor uninstaller 完成并重启。重启后确认：

- `OpenInputBridgeKeyboard`/`OpenInputBridgeMouse` 服务不存在；
- OIB UpperFilters 已移除；
- 普通键盘和 RC003 走 inbox driver 且输入正常；
- Axonkey 正确显示 backend missing，而不是 working。

卸载异常时不要安装其他 keyboard class filter。保留日志，从恢复环境或设备管理器按 vendor 支持流程处理。

## 10. 交割完成定义

只有以下全部达成，才可把本任务从“实现完成、真机待验收”改为“已解决”：

- 真实 WHQL package 和授权通过审计；
- Windows 原生 build/test/NSIS 全绿；
- RC003 全部重连与失败透传矩阵通过；
- 普通键盘零误捕获；
- 安装、卸载、回滚验证通过；
- 结果和证据写回方案、`SOURCE.md` 和发布记录；
- coherent Windows 迁移改动单独提交，未混入用户的 macOS 工作。
