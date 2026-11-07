# 设备目录与扩展边界

设备元数据、输入列表、遥控器区域与硬件识别规则统一维护于 `device-packages/builtin.json`；本地注册表及后续兼容引擎/云端分发约定见 [设备支持包](DEVICE_PACKAGES.md)。型号目录中的视图、按键和区域文件为兼容出口，原生协议实现仍留在各型号目录。

设备实现按型号聚合，已有型号级工作区继续兼容。新的设备首页通过独立实例层处理扫描、绑定和后台监听，允许同型号多实例。概念、平台差异和后续接入要求见 [设备集成约定](DEVICE_INTEGRATION.md)。

## 前端

```text
src/devices/
  types.ts                  公共设备、按键视图、设置页契约
  packages.ts               JSON 加载、校验与实例支持包注册表
  registry.ts               旧型号配置及系统鼠标注册，不加载 React 页面
  pages.ts                  型号到设置页组件的注册
  shared/
    DeviceWorkspaceHeader.tsx
    RemoteControl.tsx         五款遥控器共用的按键交互图
  xiaomi-remote/
    definition.ts           RC003 型号与实例支持包定义
    view.ts                 按键视图、区域与图片地址
    buttons.ts              按键定义
    geometry.ts             区域定义
    XiaomiRemoteSettingsPage.tsx
  cmiot-a15-remote/
    definition.ts
    view.ts
    buttons.ts
    geometry.ts
    CmiotA15SettingsPage.tsx
  system-mouse/
    definition.ts
    inputs.ts               鼠标区域、输入 ID、输入辅助函数
    SystemMouseSettingsPage.tsx
  xbox-controller/
    definition.ts           蓝牙手柄实例支持包定义
    inputs.ts               手柄按键、方向与输入 ID
    ControllerDiagram.tsx
    xbox-controller-keymap.svg
  integration/              跨型号的发现、绑定、实例配置与工作区
```

每个型号的 `index.ts` 是公开出口；跨型号的设备元数据、输入和公共类型从
`src/devices/index.ts` 导入。旧 `deviceModel.ts`、`remoteControlGeometry.ts` 和
`devices/remoteTypes.ts` 转发入口已移除，调用方已迁移。
`integration/model.ts` 从声明注册表构建支持包并定义实例契约，不再内嵌型号按键或图片定义；
实例工作区从支持包读取遥控器视图。型号级注册仍用于旧配置迁移和鼠标工作区，不能当作废弃代码删除。
设备底图和卡片图位于 `public/`（含 `xbox-controller.svg`）；手柄内联交互图仍位于型号目录。遥控器资源 URL 保持不变。
全局配置和跨设备映射编辑仍在现有位置；它们不属于单一设备型号。

## Rust 与 macOS 桥接

```text
src-tauri/src/devices/
  mod.rs                    仅声明型号与共享模块
  shared.rs                 蓝牙 HID 服务标识解析
  cmiot_a15/
    mod.rs                  A15 按键协议与 HID 会话
    recording.rs            按住/点击录音控制
    voice.rs                FC 分片重组、解扰与 PCM 帧
    siren.rs                A15 使用的 G.722.1 解码封装
    README.md               音频协议与平台实现说明
  xbox/
    mod.rs                  已验证蓝牙型号的报告解析与按键状态
  xiaomi_remote/
    mod.rs
    input.rs                RC003 按键报告解析
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
拥有自己的蓝牙会话、解码器、PCM 队列和增益。输出固定为 Windows 的 Quarbor Virtual Microphone
或 macOS 的 MiRemoteV 2ch，不保留每设备输出选择。`native/macos_pcm_queue.h`
是每个 macOS 音频实例使用的 PCM 缓冲实现。
`input_service` 和 `native/macos_input.m` 仍承载共享输入捕获与映射执行，不能
整块移入某个型号目录。`managed/report.rs` 按型号分发报告并统一数值表示，
各型号的按键布局和协议解析放在 `devices/`；平台连接和手势调度仍留在输入服务。
A15 的 `HidSession` 供 macOS 与单元测试使用，Windows 的驱动通道直接组合共享的
按键状态、录音控制和音频流模块；不能因 Windows 生产构建未使用会话封装就删除它。
macOS 原生构建入口和直接引用桥接源码的测试已更新到新路径。

## 设备实例与手柄

- `src/devices/integration/model.ts`：内置支持包、发现结果和实例契约。
- `src/devices/integration/useDeviceInstances.ts`：原生查询、串行保存与浏览器预览存储。
- `src/devices/integration/DeviceHub.tsx`：首页、集成绑定、实例配置与状态。
- `src/devices/xbox-controller/`：手柄输入、实例支持包、无品牌图标的 SVG 资源与交互图。
- `src-tauri/src/input_service/managed/`：HID 发现、物理身份、原生持久化、独立输入会话、协议解码与手势调度。

新的实例存储独立于旧型号级配置。macOS RC003 与已验证蓝牙手柄可使用实例监听；
A15 已接入 macOS 独占 HID、共享按键/录音协议和 MiRemoteV 输出，仍待 macOS 实机验证。
A15 的 macOS 输入适配位于 `input_service/managed/a15.rs`，平台按键输出位于
`input_service/macos/remote_output.rs`，音频桥以 external-input 模式复用现有 PCM 播放器。
Windows RC003 输入和语音服务都按实例维护；每个实例注册自己的 Quarbor pipe 和蓝牙会话，Windows GATT 会话按绑定的
蓝牙地址筛选。具体支持边界不能仅凭目录是否存在判断，参见集成约定中的平台支持说明。
