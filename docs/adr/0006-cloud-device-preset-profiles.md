# 0006. 云端设备预制配置文件下发与实例化边界

- 状态：`accepted`
- 日期：2026-11-21
- 关联 Issue：[leowzz/axonkey#102](https://github.com/leowzz/axonkey/issues/102)

## 背景

普通用户首次集成遥控器、手柄或桌面小键盘后，如果初始配置完全为空，需要先逐个按键录制并理解“点击 / 双击 / 长按 / 光标移动 / 滚轮 / 系统按键”等概念才能开始使用。与此同时，不同设备（如 RC003、CMIOT-A15、XM-BT-29、Kivo K18 Lite、G17 Touch、Xbox 手柄）拥有差异较大的键位矩阵，且预制方案需要随新设备接入或通用习惯调优随时在服务端更新，无需等待客户端发版。

## 决定

1. **云端主存储 + 扩展查询**：
   - Relay 数据库新增 `device_model_presets` 表关联 `device_models(id)`，每条预制包含独立 `slug`（同型号唯一）、显示名称、场景说明、适用平台（`all` / `macos` / `windows`）、同平台唯一常规默认标记 `is_default`（不可与 `quick` 同时为真）、排序权重 `sort_order`、标准 `behaviors` 映射与可选 OLED `display` 配置。
   - `/api/v2/device-models?app_id=axonkey&include_presets=1` 在型号目录中按批量查询附带 `presets`（遵循既有 `cache_ttl_seconds` 本地缓存策略），并另提供 `GET /api/v2/device-presets?app_id=axonkey&model_code=<code>` 按型号按需拉取与管理端 CRUD（`/api/console/device-models/{id}/presets`）。
2. **本地只读兜底**：
   - Axonkey 在 `src/devices/bundledPresets.ts` 保留一份轻量内置兜底预制（与云端迁移基线一致）；客户端合并数据时，若某型号在云端返回至少一套适用当前平台的预制，优先使用云端版本以便热更新生效；离线或未拉取到云端目录时自动回退内置预制。
3. **物化实例化边界（只复制、不动态引用）**：
   - 用户接入设备启用默认预制，或在工作区点击「复制为新配置」/「覆盖当前配置」时，客户端调用 `materializePresetToProfile()` 为新配置与每个动作重新生成本地 UUID，并将标准 `ApplicationProfile` 写入本地设备实例配置。
   - 已落地到用户设备的配置完全独立于云端模板存储与同步（通过既有 `user_device_configs` 协议上云），后续云端调整预制不会静默覆盖用户已个性化修改的按键映射。

## 主要取舍与影响

- **复制物化 vs. 运行时继承**：选择复制物化避免了“云端模板改动导致用户部分已改键位失效或冲突”的复杂合并逻辑，也让配置导入导出与历史版本云端备份契约保持 100% 兼容。
- **扩展型号目录 vs. 启动阶段强制 N 次请求**：通过 `include_presets=1` 复用现有的设备型号目录缓存与失效节奏，不增加客户端冷启动请求数，离线兜底同时保证完全断网下的首用体验。
