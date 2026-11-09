# YYYKQ 遥控器 USB 桥接

ESP32-S3 通过 BLE 和 `YYYKQ` 建立配对，通过板子的原生 USB 口把键盘、鼠标和媒体控制报告送给 Mac。同一个 USB 连接也提供串口，方便检查原始报告。

## 烧录和试用

```sh
pio run
pio device list
pio run -t upload --upload-port /dev/cu.usbmodemXXXX
```

用 ESP32-S3 的原生 USB 口连接 Mac。运行时设备名为 `YYYKQ Remote Bridge`，串口设备名和下载模式不同。再次烧录时，以 1200 baud 打开并关闭运行中的桥接串口，板子会重新进入下载模式。也可以按住板子的 BOOT，按一下 RESET，再松开 BOOT。

固件启动后会持续扫描地址为 `0C:F3:CE:78:65:6B` 的这只遥控器。让遥控器短暂进入配对模式，稍等两三秒再按键。以后断开时，固件会重新扫描。

```sh
pio device monitor --port /dev/cu.usbmodemXXXX --baud 115200 --dtr 1
```

串口的 `SUBSCRIBED reports=0x7` 表示三类标准报告都已订阅。按键日志形如 `HID id=3 usb=1 data=e200`，其中 `usb=1` 表示固件已将该报告交给 USB HID。此 Demo 转发报告 ID 1、2、3，保留遥控器的原始 HID 用途码。私有报告不转发，语音未验证。
