# Windows 重连兼容修复

此分支集成 [interception-driver-fix v0.5.2](https://github.com/hygorostrowskij/interception-driver-fix/tree/e1a7720863f514d51caf06b020da5c0d2e345c41)。它以 LocalSystem 启动时一次性服务创建系统级 KeyboardClass/PointerClass 链接；不替换 Interception 驱动，也不持续监听设备。影响所有使用 Interception 的设备，不仅 RC003。

编号问题、符号链接算法及服务生命周期的解释见[重连问题说明：修复原理](./INTERCEPTION_HOTPLUG_INCIDENT.md#修复原理)。

[Axonkey #32 用户反馈](https://github.com/leowzz/axonkey/issues/32#issuecomment-6037064284) 提供了断连和睡眠后恢复的个案依据。本集成尚未完成 Windows 实机验证，不代表 #25、#20 已解决，也不保证已失效设备免重启恢复。

## 构建与获取

预发布安装包在 [GitHub Releases](https://github.com/leowzz/axonkey/releases) 的 RC 版本下提供，需等待对应 Windows 构建完成。也可拉取 `feat/interception-reconnect-fix` 分支自行构建。

需要离线转移源码时，可将本地 Git bundle 转移到 Windows，在已有仓库导入：

```powershell
git fetch C:\transfer\axonkey-interception-fix.bundle feat/interception-reconnect-fix:feat/interception-reconnect-fix
git switch feat/interception-reconnect-fix
```

也可从 bundle 新建 checkout：

```powershell
git clone -b feat/interception-reconnect-fix C:\transfer\axonkey-interception-fix.bundle axonkey-fix
cd axonkey-fix
```

Windows 11 x64 构建前提：Node.js 22、Rust stable MSVC、Visual Studio 2022 C++ 桌面工具和 Windows SDK、Git、CMake ≥ 3.24（均在 PATH）。首次构建需要联网获取固定 vcpkg 提交和依赖；应用运行时不下载修复程序。

```powershell
Copy-Item .env.example .env
npm ci
npm run test:interception-fix
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\interception-fix.test.ps1
npm run tauri build -- --bundles nsis
```

Tauri 的 `beforeBuildCommand` 自动执行 `scripts/build-interception-fix.ps1`。它只构建服务，不运行服务或安装器。生成文件在 `vendor/interception-fix/`，包含 exe、完整性 manifest 和 vcpkg 依赖版权文件；缺失许可证、哈希不符或架构不符会停止构建。NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。

`make dev` 或 `npm run tauri dev` 也会在启动 Vite 前准备 Windows 修复服务资源；首次启动需要上述构建工具和网络。后续开发启动复用通过完整性校验的 `vendor/interception-fix/`，正式构建仍从固定源码构建。CMake 未加入 PATH 时会尝试使用 Visual Studio 自带的 CMake。修改修复服务源码后，使用下面的命令重新构建资源。

只构建修复服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-interception-fix.ps1
node scripts\verify-interception-fix.mjs --artifact
```

Mac 检查不能代替 MSVC/CMake/vcpkg 构建、NSIS 包和 Windows 服务启动验证。CI 构建通过也不能代替以下 Windows 实机验收。

## 安装与启用

1. 从 Axonkey 首次设置中的“驱动安装”启动 Interception 安装。修复会在同一条管理员流程中自动安装；若曾安装上游 `InterceptionDriverFix`，先用其原卸载器卸载并重启，此集成拒绝覆盖它。
2. 对已经安装 Interception 的升级用户，Axonkey 首次检测到输入驱动时会弹出可选增强提示。选择“安装增强”后才会请求 UAC；选择“暂不安装”不会影响基本按键映射，之后仍可在“设置 → 设备与权限”中手动安装。也可在仓库运行：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\interception-fix.ps1 -Action install
   ```

3. **重启 Windows**。启用步骤只注册 `AxonkeyInterceptionFix` 自动启动服务，不立即启动它。服务执行后处于“已停止”是一次性服务的正常现象；`ExitCode` 非零或日志没有 `Success` 才需要调查，不能单凭“已安装”认定输入已恢复。
4. 用普通权限运行 Axonkey，不要为主体勾选“以管理员身份运行”。确认正常映射、长按松开和普通键盘鼠标不受影响。

配置路径：`%ProgramData%\Axonkey Interception Fix\interception-driver-fix.ini`：

```ini
[default]
lockdown=no
verbose=yes
keyboard-symlinks=1000
pointer-symlinks=1000
```

这里必须保持 `lockdown=no`。Axonkey 的 Interception worker 在普通权限主进程中；Frida/HID 提权 helper 只负责额外按键。v0.5.2 的 `no` 只跳过 ACL 写入，不恢复以前被改过的 ACL。本集成进一步移除了设备 ACL 写入函数；错误配置为 `yes` 时拒绝修复，不修改权限。上游 master 后续改变了这一语义，所以不可直接换成 master 或“最新版”。

服务 exe 与备用管理脚本保存在 `%ProgramFiles%\Axonkey Interception Fix`；配置及日志在上述 ProgramData 目录。目录只允许 SYSTEM/管理员修改，普通用户可读取；此文件保护与 Interception 设备 ACL 是两件不同的事。

## 验收清单

记录 Windows 版本、RC003 固件/蓝牙适配器、此分支提交号、生成 exe 的 manifest 哈希，以及下列各项结果：

- 首次重启后，服务退出码为 0，服务日志出现 `Success`；普通权限 Axonkey 的 10 个 Interception 按键可用。
- 连续至少 5 次 RC003 断开/重连，记录每次恢复耗时、漏键、卡键；保留失败日志，不仅观察系统蓝牙“已连接”。
- 连续至少 3 次睡眠/唤醒，再测试按下与松开、单击/双击/长按。
- 普通键盘、鼠标重插后仍可用；不意外拦截其他设备。
- Frida 额外三键关闭/开启分别检查，区分两个输入通道的结果。
- UAC 取消、重复启用、已有上游服务时显示失败原因，不能声称成功。
- 完成卸载并重启后，再确认原输入流程可用，服务不再存在。

只读检查与日志：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\interception-fix.ps1 -Action status
sc.exe qc AxonkeyInterceptionFix
sc.exe query AxonkeyInterceptionFix
Get-Content "$env:ProgramData\Axonkey Interception Fix\logs\interception-driver-fix.log" -Tail 40
```

管理操作日志：`%LOCALAPPDATA%\Axonkey\logs\interception-fix-*.log`（UAC 启动结果）和 `%ProgramData%\Axonkey Interception Fix\logs\manage-*.log`（提权操作详情）。哈希校验只表示内容与构建 manifest 一致，并非代码签名或可重复构建证明。

## 回滚

1. 卸载 Axonkey 的 Interception 输入驱动时，驱动卸载流程会先卸载修复。也可在设置页点击 **卸载修复**，或运行同一脚本 `-Action uninstall`。脚本先禁用服务，等待一次性执行结束，再删除服务；超时会报告“已禁用但仍在运行”，需要重启后重试。
2. **重启 Windows**，检查服务已不存在，再测试 RC003。删除服务不移除本次启动内已有的对象链接，不恢复旧 ACL，退出 Axonkey 也不能代替重启。
3. 修复服务独立于当前用户安装的 Axonkey。卸载整个 Axonkey **之前**先卸载输入驱动和修复；应用更新不会自动替换已安装服务。若已经卸载应用，可用保留的备用脚本：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramFiles\Axonkey Interception Fix\manage.ps1" -Action uninstall
   ```

4. 卸载后保留服务文件、配置和日志以便诊断。确认服务删除且已重启后，可用管理员权限手动删除上述两个 `Axonkey Interception Fix` 专用目录。升级修复服务时先卸载、重启，再通过新版本 Axonkey 启用。

Interception 驱动本身使用原有驱动设置卸载，流程会先卸载修复。若机器已无输入，请使用可靠的备用输入或系统恢复路径；本方案未承诺即时救回已有故障。
