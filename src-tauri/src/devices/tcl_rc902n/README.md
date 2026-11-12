# TCL RC902N

图稿、正面与侧面按键及原始 HID 采集位于 `public/device-descriptors/tcl-rc902n.svg`（确认键按下仍为 `binding="pending"`）。语音触发键为 `A`（`#key-assistant`，稳定 ID `tcl-rc902n.assistant`，HID 采集 `03 21 02` / `03 00 00`）。

## 语音协议与共享后端

- 与 RC902V 共用同一套 Google ATVV BLE GATT PTT 语音实现（`engine="tcl-rc902v-atvv"`，服务 `AB5E0001-5A21-4F05-BC7D-AF01F617B664`），支持「按住录音，松开停止」（`hold`）与「点击开始，再次点击停止」（`click`）两种录制模式（`trigger-modes="hold click"`）。
- Windows 与 macOS 复用 `xiaomi_remote::voice` 的实例级 BLE GATT 工作线程、增益校准与虚拟麦克风输出，并按实例绑定的 12 位蓝牙地址及 `DEV_VID&010417_PID&0304` 身份严格隔离同型号/跨型号（RC902N/RC902V）设备。
- 完整的 ATVV v1.0/v0.4 状态机、连续 IMA ADPCM 解码、8 kHz -> 16 kHz 重采样及实机待验证边界见 [RC902V 音频说明](../tcl_rc902v/README.md)。
