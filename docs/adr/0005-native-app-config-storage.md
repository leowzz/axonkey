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
2. **启动预加载与同步读写桥接**：
   - 主窗口挂载前通过 `bootstrapAppStorage()` 一次性加载 `app-config.json` 快照到前端内存映射表 `appStorage`，保持渲染层同步读取零闪烁，写入通过微任务合并批量落盘；涉及页面重载的操作（导入备份、清除本地数据）以及 CLI 修改在返回或刷新前执行 `flushAppStorage()` 等待落盘完成。
   - 桌面端启动时若检测到当前 WebView `localStorage` 仍存有历史配置键，自动将缺失键补齐写入 `app-config.json` 并删除对应的 `localStorage` 条目。
   - 浏览器预览与 Node 单元测试环境未注入 Tauri 运行时时自动回退至 `localStorage`。

## 主要取舍及影响

- **取舍：单文件键值映射表 vs 按子域拆分为多个零散文件**
  - 鼠标配置、全局设置与常用序列体量小（通常数 KB 至数十 KB），单文件 `app-config.json` 能复用已有配置校验、数据备份恢复（`restoreBackupStorage`）与历史格式迁移（`configMigration`）逻辑，同时保证跨键批量更新的原子性。
