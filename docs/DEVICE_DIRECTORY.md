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
    RemoteControl.tsx         协议 SVG 共用的按键交互图
    descriptorSvg.ts         生成索引到设备视图的通用适配
  generatedDescriptors.ts   从协议 SVG 生成，不手工编辑
  xiaomi-remote/
    definition.ts           RC003 型号与实例支持包定义
    view.ts                 按键视图、区域与图片地址
    buttons.ts              从协议索引导出兼容按键 ID 与标签
    XiaomiRemoteSettingsPage.tsx
  cmiot-a15-remote/
    definition.ts
    view.ts
    buttons.ts
    CmiotA15SettingsPage.tsx
  system-mouse/
    definition.ts
    inputs.ts               鼠标区域、输入 ID、输入辅助函数
    SystemMouseSettingsPage.tsx
  xbox-controller/
    definition.ts           蓝牙手柄实例支持包定义
    inputs.ts               从协议索引导出手柄输入
    xbox-controller.svg     首页卡片图标
  integration/              跨型号的发现、绑定、实例配置与工作区
```

每个型号的 `index.ts` 是公开出口；跨型号的设备元数据、输入和公共类型从
`src/devices/index.ts` 导入。旧 `deviceModel.ts`、`remoteControlGeometry.ts` 和
`devices/remoteTypes.ts` 转发入口已移除，调用方已迁移。
`integration/model.ts` 只聚合各型号的支持包并定义实例契约，不再内嵌型号按键或图片定义；
实例工作区从支持包读取遥控器视图。型号级注册仍用于旧配置迁移和鼠标工作区，不能当作废弃代码删除。
协议图形统一放在 `public/device-descriptors/`；旧的四套 keymap SVG 与 TS 区域表已移除。`scripts/generate-device-descriptors.mjs` 在开发/构建前生成前端输入索引，图形和热区以同一 SVG 为来源。
全局配置和跨设备映射编辑仍在现有位置；它们不属于单一设备型号。

## Rust 与 macOS 桥接

```text
src-tauri/src/devices/
  mod.rs                    仅声明型号与共享模块
  shared.rs                 蓝牙 HID 服务标识解析
  cmiot_a15/
    mod.rs                  通用描述器引擎的 HID 音频会话适配
    recording.rs            按住/点击录音控制
    voice.rs                FC 分片重组、解扰与 PCM 帧
    siren.rs                A15 使用的 G.722.1 解码封装
    README.md               音频协议与平台实现说明
  device_descriptor.rs     SVG 元数据入口解析和校验
  descriptor_registry.rs    内置设备、身份和配置兼容键
  engine.rs                 通用报告解码、状态分组和阈值
  xbox/
    mod.rs                  使用真实 Xbox 报告的引擎回归测试
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
拥有自己的蓝牙会话、解码器、PCM 队列和增益。输出固定为 Windows 的 Quarbor Virtual Microphone
或 macOS 的 MiRemoteV 2ch，不保留每设备输出选择。`native/macos_pcm_queue.h`
是每个 macOS 音频实例使用的 PCM 缓冲实现。
`input_service` 和 `native/macos_input.m` 仍承载共享输入捕获与映射执行，不能
整块移入某个型号目录。报告输入统一通过 `devices/engine.rs` 读取 SVG 布局，旧的各型号按键表和解析分支已删除；平台连接、系统输出和手势调度仍留在输入服务。
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

## TCL 遥控器

关联 [Issue #67](https://github.com/leowzz/axonkey/issues/67)。图稿和 HID 采集来自 `feat/leo/proto` 的三个 `docs/device-drafts/tcl-*.svg`；运行时资源是 `public/device-descriptors/tcl-*.svg`。

| 型号   | 前端目录                         | Rust 入口                           | 联合身份条件                                                    | 已采集按键 | 语音                                       |
| ------ | -------------------------------- | ----------------------------------- | --------------------------------------------------------------- | ---------- | ------------------------------------------ |
| RC802A | `src/devices/tcl-rc802a-remote/` | `src-tauri/src/devices/tcl_rc802a/` | `DEV_VID&010416_PID&0301` + 2A24 含 `BT_RC802A` + 2A29 含 `TCL` | 22         | EB 启停 / EC ICO 按住语音                  |
| RC902N | `src/devices/tcl-rc902n-remote/` | `src-tauri/src/devices/tcl_rc902n/` | `DEV_VID&010417_PID&0304` + 2A28 含 `RC902N`                    | 22         | ATVV BLE On-request 语音（A 键，按住 / 点击启停） |
| RC902V | `src/devices/tcl-rc902v-remote/` | `src-tauri/src/devices/tcl_rc902v/` | `DEV_VID&010417_PID&0304` + 2A28 含 `RC902V`                    | 27         | ATVV BLE On-request 语音（A 键，按住 / 点击启停） |

型号匹配声明来自 SVG。Windows/macOS 读取 Device Information 的 `2A24/modelNumber`、`2A29/manufacturer` 和 `2A28/softwareRevision`，发现候选不代表已确认型号。绑定、驱动目标和输入启动都要求真实信息字段匹配，不能仅凭名称或 `detectedKind` 回退。RC902N/V 共用硬件候选身份，识别后只更新型号，不重算已发现实物 ID。

按键通过现有描述引擎处理原始字段，未知 Usage Page 不补写成标准键盘或 Consumer usage，未配置输入不承诺原始按键转发。

RC802A 仅支持按住录音、松开停止（`hold`），复用现有 CMIOT-A15 的按住录音控制、G.722.1 解码和每实例 PCM 输出。协议细节及验证边界见 [RC802A 音频说明](../src-tauri/src/devices/tcl_rc802a/README.md)。

RC902N 与 RC902V 通过 `AB5E0001` Google ATVV BLE GATT 服务以 On-request (`0x00`) 模式接入各自 `A` 键（`tcl-rc902n.assistant` / `tcl-rc902v.assistant`）语音，保留 HID `A` 键边沿上报，支持按住录音、松开停止（`hold`）和按下开始、再次按下停止（`click`）两种模式，复用 `xiaomi_remote::voice` 的实例级蓝牙工作线程与虚拟麦克风输出。协议细节及验证边界见 [RC902N 音频说明](../src-tauri/src/devices/tcl_rc902n/README.md) 与 [RC902V 音频说明](../src-tauri/src/devices/tcl_rc902v/README.md)。

## 投影仪语音遥控器（按键 HID 已采集，音频待接入）

| 品牌 / 型号     | 前端目录                              | Rust 入口                                | 硬件匹配条件              | 输入状态                                                               | 语音   |
| --------------- | ------------------------------------- | ---------------------------------------- | ------------------------- | ---------------------------------------------------------------------- | ------ |
| Hisense RCF3B65 | `src/devices/hisense-rcf3b65-remote/` | `src-tauri/src/devices/hisense_rcf3b65/` | `DEV_VID&01109B_PID&3837` | 18 个正面按键已采集（`0x01` / `0x6F` 九字节）                          | 待接入 |
| 斐讯 DB1-R      | `src/devices/phicomm-db1-r-remote/`   | `src-tauri/src/devices/phicomm_db1_r/`   | `DEV_VID&01005D_PID&0001` | 12 个正面按键已采集（`0x01` 九字节 / `0x02` 三字节，红外 TV 键已移除） | 待接入 |
