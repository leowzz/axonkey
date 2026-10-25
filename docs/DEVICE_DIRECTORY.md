# 设备目录与扩展边界

本轮整理按设备型号聚合实现，不改变现有设备 ID、配置格式和原生命令。
目前仍是固定三个设备；同型号多实例需要下一阶段引入实例身份和独立会话。

## 前端

```text
src/devices/
  types.ts                  公共设备、按键视图、设置页契约
  registry.ts               型号元数据注册，不加载 React 页面
  pages.ts                  型号到设置页组件的注册
  shared/
    DeviceWorkspaceHeader.tsx
  xiaomi-remote/
    definition.ts           RC003 型号定义
    view.ts                 按键视图、区域与图片地址
    buttons.ts              按键定义
    geometry.ts             区域定义
    XiaomiRemoteControl.tsx
    XiaomiRemoteSettingsPage.tsx
    settings/VoiceOutput.tsx 输出列表获取及展示
  cmiot-a15-remote/
    definition.ts
    view.ts
    buttons.ts
    geometry.ts
    CmiotA15RemoteControl.tsx
    CmiotA15SettingsPage.tsx
  system-mouse/
    definition.ts
    inputs.ts               鼠标区域、输入 ID、输入辅助函数
    SystemMouseSettingsPage.tsx
```

每个型号的 `index.ts` 是公开出口。`deviceModel.ts` 与 `devices/remoteTypes.ts`
暂时保留为兼容导出，避免这次整理要求所有调用者同时迁移。
设备图片仍保留在 `public/`，保持现有资源 URL 与截图/测试引用稳定。
全局配置和跨设备映射编辑仍在现有位置；它们不属于单一设备型号。

## Rust 与 macOS 桥接

```text
src-tauri/src/devices/
  mod.rs
  xiaomi_remote/
    mod.rs
    voice/
      mod.rs
      atvv.rs               RC003 ADPCM 解码
      windows.rs            Windows RC003 蓝牙与语音输出后端
      macos.rs              macOS RC003 Rust/Objective-C 桥接

src-tauri/native/devices/xiaomi_remote/
  macos_audio.m             CoreBluetooth、会话与 AVAudioEngine
  macos_audio_trace.h       RC003 蓝牙事件追踪
```

`audio_service` 保留统一入口、公共状态、增益约束、诊断和监测；当前服务通过
重导出使用 RC003 后端。`native/macos_pcm_queue.h` 是共享 PCM 缓冲实现。
`input_service` 和 `native/macos_input.m` 仍承载共享输入捕获与映射执行，不能
整块移入某个型号目录；后续应先明确协议解析与平台输入基础设施的接口。
macOS 原生构建入口和直接引用桥接源码的测试已更新到新路径。

## 下一阶段：同型号多实例

1. 引入独立的 `DeviceTypeId` 与 `DeviceInstanceId`；已有三个设备迁移为初始实例。
2. 在 `instances.ts` 管理实例元数据和持久化，不存放原生运行中连接。
3. 配置、选中状态与输入事件按实例 ID 关联；按键 ID 保持型号内定义。
4. Rust 增加设备管理器，每个实例持有独立连接、解码器和语音队列。
5. 完成上述接入后再开放同型号设备添加，避免多个界面实例共享一个原生会话。

本轮不预建空管理器或空实例存储，以免目录存在却没有可用实现。
