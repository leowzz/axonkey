# 0005 桌面端持久化配置统一存储至软件数据目录

- 状态：`accepted`
- 关联 Issue：[#91](https://github.com/leowzz/axonkey/issues/91)

## 背景

桌面端此前将托管物理设备实例（`device-instances.json`）与云端登录凭据（`relay-session.json`）存放在原生软件数据目录（`app_data_dir`），但鼠标映射配置、全局开关与参数、常用行为序列、音频增益、云端同步元数据与界面状态仍存放在 WebView 的 `localStorage` 中。

WebView 的 `localStorage` 按应用容器身份与前端 Origin（如开发态 `http://localhost:3001` 与正式包 `tauri://localhost` / `http://tauri.localhost`）隔离存储，切换运行形态或清理系统 WebView 数据时会导致配置割裂。

## 决定

1. **统一原生文件存储边界**：
   - 在软件数据目录新增 `app-config.json`（同目录配 `.tmp` 临时写入、`sync_all` 刷盘与 `.bak` 备份恢复，Unix 文件权限 `0600`），集中承载鼠标映射配置、全局设置、常用序列、音频设置、云端同步元数据与界面偏好。
   - 临时 HTTP 响应缓存（行为库分页缓存、设备型号目录缓存）和纯浏览器预览模拟项不进入 `app-config.json`，避免高频缓存刷新污染或膨胀配置文件。
2. **启动预加载与无损迁移兼容**：
   - 主窗口挂载前通过 `bootstrapAppStorage()` 一次性加载 `app-config.json` 快照到前端内存映射表 `appStorage`，保持渲染层同步读取零闪烁，写入通过微任务合并批量落盘；涉及页面重载、应用更新重启（`restart_app`）、页面隐藏卸载以及 CLI 修改在返回或刷新前执行 `flushAppStorage()`。
   - 桌面端首次迁移时（`app-config.json` 尚未写入 `axonkey.storage-migrated.v1` 标记），自动将当前 WebView `localStorage` 中的历史配置键无损补齐至 `app-config.json`，**不主动清除原 `localStorage` 条目**：一方面避免首次落盘失败导致双端数据同时丢失，另一方面保留用户回退旧版本时的配置兼容性；仅当用户主动执行删除或「重置本地数据」时同步清理两处存储。
   - 浏览器预览与 Node 单元测试环境未注入 Tauri 运行时时自动回退至 `localStorage`。

## 主要取舍及影响

- **取舍：单文件键值映射表 vs 按子域拆分为多个零散文件**
  - 鼠标配置、全局设置与常用序列体量小（通常数 KB 至数十 KB），单文件 `app-config.json` 能复用已有配置校验、数据备份恢复（`restoreBackupStorage`）与历史格式迁移（`configMigration`）逻辑，同时保证跨键批量更新的原子性。
