# Windows 蓝牙配对失败排查：BLE IRK 冲突

记录日期：2026-11-15。状态：已确认系统蓝牙栈因 IRK（Identity Resolving Key）冲突拒绝配对；实机移除 `YYYKQ`（`0c:f3:ce:7f:24:1e`）后，`TCL_RC902N_M1` 已于 10:57 成功配对。以下时间均为北京时间。

[常见问题与排障](TROUBLESHOOTING.md) · [Windows 输入](WINDOWS_INPUT.md) · [TCL RC902N 说明](../src-tauri/src/devices/tcl_rc902n/README.md)

## 现象与环境

在 Windows 11“设置 → 蓝牙和其他设备”中添加 `TCL_RC902N_M1` 时，界面显示键盘图标、设备名 `TCL_RC902N_M1` 与红色提示“请尝试重新连接设备。”，无法完成系统配对。因为配对未成功，系统未生成 `BTHLEDEVICE` / HID 设备节点，`setupapi.dev.log` 中也没有该设备或其硬件标识（`010417` / `0304` / `0CE2902E274C`）的驱动安装记录。

| 项目 | 本次环境 |
| --- | --- |
| 操作系统 | Windows 11 x64（主机 `LEO-SDT`） |
| 待配对设备 | `TCL_RC902N_M1`，BLE 地址 `0c:e2:90:2e:27:4c` |
| 蓝牙适配器 | Realtek Bluetooth Adapter（`USB\VID_0BDA&PID_0852\00E04C000001`，驱动 `18.4032.2510.900`） |
| 当时已配对 BLE 设备 | `MI RC`（`c0:5d:39:c2:b4:0e`）、`YYYKQ`（`0c:f3:ce:7f:24:1e`）、`MX Master 3S`（`de:db:92:54:02:48`）、`MX Master 3S B`（`d3:a0:cf:2c:61:e6`）、`MCHOSE K87S-1`（`dc:33:62:d0:76:01`）、`Seenda COS500`（`ff:47:d5:5f:e9:bf`） |

本次记录对应本机本次采样，不能直接推广为所有 `TCL RC902N` 批次或全部 Realtek 方案遥控器都会出现同一问题。

## 已确认的证据

### Windows System 事件日志

在 2026-11-15 10:48～10:49 两次点击配对期间，`System` 日志连续记录到以下事件：

| 时间 | 来源 | 事件 ID | 关键内容 |
| --- | --- | --- | --- |
| 10:48:09 | `Microsoft-Windows-DeviceAssociationService` | `3505` | `设备关联失败 - 枚举器。`；`AepId = BluetoothLE#BluetoothLEbc:c7:46:e4:32:c3-0c:e2:90:2e:27:4c`，`ProtocolError = 2147942401`（`0x80070001`） |
| 10:48:16 | `BTHUSB` | `35` | `设备 (0c:e2:90:2e:27:4c) 正在尝试分发配对设备已使用的标识解析密钥。如果要与此设备配对，配对请求将遭拒绝，你可能需要先删除现有的配对信息。` |
| 10:48:16 | `Microsoft-Windows-DeviceAssociationService` | `3501` | `设备关联失败。`；同上 `AepId`，`ProtocolError = 2148073475`（`0x80090003`，即 `NTE_BAD_KEY`） |
| 10:48:28 | `BTHUSB` | `35` | 同上（第二次配对尝试，同一地址 `0c:e2:90:2e:27:4c` 再次因 IRK 冲突被拒绝） |
| 10:48:29 | `Microsoft-Windows-DeviceAssociationService` | `3501` | 同上（`ProtocolError = 2148073475` / `0x80090003`） |
| 10:49:11 | `Microsoft-Windows-DeviceAssociationService` | `3505` | 同上（`ProtocolError = 2147942401` / `0x80070001`） |

同日志中当日 `06:41` 起每隔数分钟出现一次 `BTHUSB` 事件 ID `5`（“蓝牙驱动程序需要某一大小的 HCI 事件，但是没有收到”），属于本机 Realtek 适配器既有的周期性记录，不作为本次 `10:48` 配对拒绝的直接原因。

### 蓝牙注册表与指纹线索

检查 `HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices` 与 WinRT `BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)` 结果：

- `0ce2902e274c` 在 `2026/11/15 10:48:16` 被写入 `LeContainerId`（`c6c63670-6745-591f-8e62-8799acf2e612`）及指纹 `Fingerprint:08;005D;8762;0000000000000000;000000;7B65FDEB2E1C5BA0;0000000000000000;FFFF;0000;0000;06;7966;03C1;00;00000000087830FD;FF084737D59D71F7;`。其中 `08;005D;8762` 对应芯片厂商 `0x005D`（Realtek）、LMP 版本 `8`、LMP 子版本 `0x8762`（RTL8762 系列），`03C1` 为 BLE 外观（Keyboard）；`VID`/`PID` 仍为占位 `FFFF/0000` 且无设备名称，符合“配对绑定被拒、未完成 GATT 服务读取”的状态。
- 在当时已配对的 6 台 BLE 设备中，只有 **`YYYKQ`（`0c:f3:ce:7f:24:1e`）** 使用相同芯片指纹（`ManufacturerId = 0x005D`、`LmpVersion = 8`、`LmpSubversion = 0x8762`，`VID = 0x0416`、`PID = 0x0300`）。该设备当前在系统上处于已枚举状态，且其 HID 节点（`BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&050416_PID&0300_REV&0505_0CF3CE7F241E\B&53A7AC8&2&0025`）正绑定着 `Quarbor Universal Keyboard Device`。
- `Devices` 下另有一条无名称、无 `LastSeen` 的残留键 `1308ff0000c0`（仅含 `DibServiceVersion`、`LeContainerId`、`LeContainerIDSource`）。

**验证边界**：Windows 将保存 BLE LTK/IRK 的注册表键 `HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Keys` 限制为仅 `SYSTEM` 可读。本次只读排查未提权读取 `Keys`，因此**尚未直接比对出重复的 IRK 究竟属于 `YYYKQ`、其他已配对 BLE 设备还是历史残留键**；仅根据同为 Realtek RTL8762 遥控器方案将 `YYYKQ` 列为首要怀疑对象。

## 原因与软件边界

BLE SMP（Security Manager Protocol）配对分发密钥时，如果外设分发的 IRK 与 Windows 本地已保存的某台已配对设备的 IRK 相同，Windows 蓝牙栈（`bthport`）会以 `NTE_BAD_KEY`（`0x80090003`）和 `BTHUSB` 事件 ID `35` 直接拒绝建立配对。部分基于同一芯片 SDK（例如 Realtek RTL8762）的遥控器固件如果未为每台或每款设备生成独立随机 IRK，而沿用了固定/默认 IRK，就会在同一台 Windows 主机上互斥：先配对的一台正常使用，后配对的一台报“请尝试重新连接设备。”。

该校验发生在系统蓝牙配对层，早于 GATT `180A/1812` 读取、`BTHLEDEVICE` 枚举和 Quarbor 驱动挂载。Axonkey 无法在应用层绕过 Windows 对重复 IRK 的拒绝策略；若同一台 Windows 主机确需同时接入两只共享固定 IRK 的遥控器，只能修改其中一方固件的 IRK，或让其中一台通过外部 BLE-USB HID 桥接接入（同类桥接思路见 [YYYKQ 遥控器 USB 桥接](../tools/esp32s3-remote-bridge/README.md)）。

## 快速排查方法（下次复现时）

1. **PowerShell 一键核对是否命中 IRK 冲突**（普通权限即可，先在近 30 分钟内查 `BTHUSB 35` / `DeviceAssociationService 3501/3505`）：

   ```powershell
   Get-WinEvent -FilterHashtable @{LogName='System'; Id=35,3501,3505; StartTime=(Get-Date).AddMinutes(-30)} -ErrorAction SilentlyContinue |
     Select-Object TimeCreated, ProviderName, Id, Message | Format-List
   ```

   - 若看到 `BTHUSB` 事件 ID `35`（含待配对设备 MAC 与“正在尝试分发配对设备已使用的标识解析密钥”），即可在数秒内确认是 IRK 冲突。
   - 不想开终端时，也可在 `Win + X` → **事件查看器 → Windows 日志 → 系统 → 筛选当前日志** 中输入事件 ID `35,3501,3505`。

2. **列出本机已配对设备的芯片指纹，快速锁定同方案候选设备**：

   ```powershell
   Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices' | ForEach-Object {
     $p = Get-ItemProperty $_.PSPath
     [PSCustomObject]@{
       Addr = $_.PSChildName
       Name = if ($p.Name) { [Text.Encoding]::UTF8.GetString($p.Name).TrimEnd("`0") } else { '' }
       VID  = if ($p.VID)  { '0x{0:X4}' -f $p.VID } else { '' }
       PID  = if ($p.PID)  { '0x{0:X4}' -f $p.PID } else { '' }
       Chip = if ($p.FingerprintString) { ($p.FingerprintString -split ';')[1,2] -join ';' } else { '' }
     }
   } | Format-Table -AutoSize
   ```

   对照新设备地址（如 `0ce2902e274c`）的 `Chip` 字段（如 `005D;8762`）与其余已配对设备的 `Chip`，同一芯片方案（尤其是同厂商遥控器或同芯片空名称残留项）即为优先删除排查对象。

3. **仓库文档快速定位关键词**：搜索 `BTHUSB 35`、`0x80090003`、`NTE_BAD_KEY`、`请尝试重新连接设备` 或 `IRK`。

## 实机验证记录与后续边界

- **2026-11-15 10:56～10:57 已验证**：
  - `10:56:49`：`BTHUSB` 事件 ID `10` 记录移除 `YYYKQ`（`0c:f3:ce:7f:24:1e`）并删除其链接密钥。
  - `10:57:01`～`10:57:03`：`BTHUSB` 事件 ID `8` 与 `DeviceAssociationService` 事件 ID `2500` 记录 `TCL_RC902N_M1`（`0c:e2:90:2e:27:4c`）**立即配对成功**。
  - 配对后注册表与 PnP 节点实测为 `VID = 0x0417`、`PID = 0x0304`、`REV = 0x5555`（`BTHLEDEVICE\{00001812-...}_DEV_VID&010417_PID&0304_REV&5555_0CE2902E274C`），且暴露 `AB5E0001` ATVV GATT 服务与 `0x1812` HID 服务，与 [tcl-rc902n.svg](../public/device-descriptors/tcl-rc902n.svg) 硬件条件一致。
- **尚未验证项**：
  - 尚未在 `TCL_RC902N_M1` 保持配对的状态下反向重配 `YYYKQ`，因此“两者反向回连同样互斥”按机制推断仍待实测验证。
  - 尚未验证 [tcl-rc902n.svg](../public/device-descriptors/tcl-rc902n.svg) 要求的 GATT `0x2A28` 是否包含 `RC902N`（本次检查未读取 `0x2A28` 特征值）。
- **操作提醒**：若待删除的冲突设备当前已挂载 `Quarbor Universal Keyboard Device` 且后续还要恢复其原生驱动，先通过 Axonkey 或 `axonkey-cli capture detach` 恢复原驱动，再到 Windows 蓝牙设置中删除设备。
