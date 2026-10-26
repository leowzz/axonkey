# 设备目录与扩展边界

设备实现按型号聚合，已有型号级工作区继续兼容。新的设备首页通过独立实例层处理扫描、绑定和后台监听，允许同型号多实例。概念、平台差异和后续接入要求见 [设备集成约定](DEVICE_INTEGRATION.md)。

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

`audio_service` 保留统一入口、公共状态、增益约束、诊断和监测；
`AudioServiceManager` 按 `instanceId` 管理 RC003 的独立语音服务，每个服务
拥有自己的蓝牙会话、解码器、PCM 队列、增益和输出设备。`native/macos_pcm_queue.h`
是每个 macOS 音频实例使用的 PCM 缓冲实现。
`input_service` 和 `native/macos_input.m` 仍承载共享输入捕获与映射执行，不能
整块移入某个型号目录；后续应先明确协议解析与平台输入基础设施的接口。
macOS 原生构建入口和直接引用桥接源码的测试已更新到新路径。

## 设备实例与手柄

- `src/devices/integration/model.ts`：内置支持包、发现结果和实例契约。
- `src/devices/integration/useDeviceInstances.ts`：原生查询、串行保存与浏览器预览存储。
- `src/devices/integration/DeviceHub.tsx`：首页、集成绑定、实例配置与状态。
- `src/devices/xbox-controller/`：无品牌图标的 SVG 资源与交互图。
- `src-tauri/src/input_service/managed/`：HID 发现、物理身份、原生持久化、独立输入会话、协议解码与手势调度。

新的实例存储独立于旧型号级配置。当前 macOS RC003 与已验证蓝牙手柄可使用实例监听；
Windows RC003 输入和语音服务都按实例维护；每个实例注册自己的 Quarbor pipe 和蓝牙会话，Windows GATT 会话按绑定的
蓝牙地址筛选。具体支持边界不能仅凭目录是否存在判断，参见集成约定中的平台支持说明。
