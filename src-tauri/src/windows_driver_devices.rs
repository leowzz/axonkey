use std::collections::{HashMap, HashSet};
use std::path::Path;
use windows::core::{GUID, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::*;
use windows::Win32::Devices::Properties::{DEVPKEY_Device_IsPresent, DEVPROPTYPE};
use windows::Win32::Foundation::{
    ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_DATA, ERROR_NO_MORE_ITEMS,
};
use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

use crate::quarbor_installer::Device;

const HID_CLASS: GUID = GUID::from_u128(0x745a17a0_74d3_11d0_b6fe_00a0c90f57da);
const KEYBOARD_CLASS: GUID = GUID::from_u128(0x4d36e96b_e325_11ce_bfc1_08002be10318);
const MOUSE_CLASS: GUID = GUID::from_u128(0x4d36e96f_e325_11ce_bfc1_08002be10318);
const BINDINGS: &str = r"SOFTWARE\Quarbor\UniversalKeyboard\Bindings";

struct DeviceSet(HDEVINFO);
impl Drop for DeviceSet {
    fn drop(&mut self) {
        unsafe {
            let _ = SetupDiDestroyDeviceInfoList(self.0);
        }
    }
}

pub(crate) fn list() -> Result<Vec<Device>, String> {
    enumerate(DIGCF_ALLCLASSES)
}

pub(crate) fn list_present() -> Result<Vec<Device>, String> {
    enumerate(DIGCF_ALLCLASSES | DIGCF_PRESENT)
}

fn enumerate(flags: SETUP_DI_GET_CLASS_DEVS_FLAGS) -> Result<Vec<Device>, String> {
    let set = DeviceSet(
        unsafe { SetupDiGetClassDevsW(None, PCWSTR::null(), None, flags) }
            .map_err(|e| format!("无法枚举 Windows 设备：{e}"))?,
    );
    let recovery =
        active_recovery_bindings().map_err(|e| format!("无法读取 Quarbor 恢复记录：{e}"))?;
    let root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows INF 目录。")?;
    let inf_dir = Path::new(&root).join("INF");
    let mut packages = HashMap::new();
    let mut devices = Vec::new();
    for index in 0.. {
        let mut info = SP_DEVINFO_DATA {
            cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        match unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut info) } {
            Ok(()) => {}
            Err(e) if e.code() == ERROR_NO_MORE_ITEMS.to_hresult() => break,
            Err(e) => return Err(format!("无法读取 Windows 设备列表：{e}")),
        }
        let instance_id = instance_id(&set, &info)?;
        if !is_input_node(&instance_id, info.ClassGuid) {
            continue;
        }
        let driver_key = property(&set, &info, SPDRP_DRIVER)?;
        let (inf, section) = driver_binding(&driver_key)
            .map_err(|e| format!("无法读取设备驱动 {instance_id}：{e}"))?;
        let bound = if inf.is_empty() {
            false
        } else if let Some(bound) = packages.get(&inf) {
            *bound
        } else {
            let bytes = std::fs::read(inf_dir.join(&inf))
                .map_err(|e| format!("无法读取已绑定驱动包 {inf}：{e}"))?;
            let bound = universal_package(&bytes);
            packages.insert(inf.clone(), bound);
            bound
        };
        let mut name = property(&set, &info, SPDRP_FRIENDLYNAME)?;
        if name.is_empty() {
            name = property(&set, &info, SPDRP_DEVICEDESC)?;
        }
        devices.push(Device {
            recovery_active: recovery.contains(&instance_id.to_ascii_uppercase()),
            instance_id,
            hardware_id: property(&set, &info, SPDRP_HARDWAREID)?,
            present: present(&set, &info)?,
            bound,
            name,
            inf,
            section,
        });
    }
    // Prefer live nodes when a paired device also has an older, offline instance.
    devices.sort_by(|a, b| {
        b.present
            .cmp(&a.present)
            .then_with(|| a.instance_id.cmp(&b.instance_id))
    });
    Ok(devices)
}

fn is_input_node(id: &str, class: GUID) -> bool {
    let id = id.to_ascii_uppercase();
    !id.starts_with("ROOT\\QUARBORUNIVERSALKEYBOARDOUTPUT")
        && !id.starts_with("QUARBOR\\")
        && (matches!(class, HID_CLASS | KEYBOARD_CLASS | MOUSE_CLASS)
            || id.starts_with("HID\\")
            || id.starts_with("BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}"))
}

fn instance_id(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> Result<String, String> {
    let mut size = 0;
    let _ = unsafe { SetupDiGetDeviceInstanceIdW(set.0, info, None, Some(&mut size)) };
    let mut buffer = vec![0; size as usize];
    unsafe { SetupDiGetDeviceInstanceIdW(set.0, info, Some(&mut buffer), None) }
        .map_err(|e| format!("无法读取设备实例 ID：{e}"))?;
    Ok(String::from_utf16_lossy(&buffer)
        .trim_end_matches('\0')
        .into())
}

fn property(
    set: &DeviceSet,
    info: &SP_DEVINFO_DATA,
    key: SETUP_DI_REGISTRY_PROPERTY,
) -> Result<String, String> {
    let mut size = 0;
    match unsafe {
        SetupDiGetDeviceRegistryPropertyW(set.0, info, key, None, None, Some(&mut size))
    } {
        Err(e) if e.code() == ERROR_INVALID_DATA.to_hresult() => return Ok(String::new()),
        Err(e) if e.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() => {
            return Err(format!("无法读取设备属性：{e}"))
        }
        _ => {}
    }
    let mut bytes = vec![0; size as usize];
    unsafe { SetupDiGetDeviceRegistryPropertyW(set.0, info, key, None, Some(&mut bytes), None) }
        .map_err(|e| format!("无法读取设备属性：{e}"))?;
    let units: Vec<_> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    // HardwareID is REG_MULTI_SZ; expose its first (most specific) ID, as --list did.
    Ok(String::from_utf16_lossy(&units)
        .split('\0')
        .next()
        .unwrap_or_default()
        .into())
}

fn present(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> Result<bool, String> {
    let mut value = [0u8];
    let mut kind = DEVPROPTYPE::default();
    unsafe {
        SetupDiGetDevicePropertyW(
            set.0,
            info,
            &DEVPKEY_Device_IsPresent,
            &mut kind,
            Some(&mut value),
            None,
            0,
        )
    }
    .map_err(|e| format!("无法读取设备在线状态：{e}"))?;
    Ok(value[0] != 0)
}

fn driver_binding(driver: &str) -> std::io::Result<(String, String)> {
    if driver.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(format!(r"SYSTEM\CurrentControlSet\Control\Class\{driver}"))?;
    Ok((
        optional_value(&key, "InfPath")?,
        optional_value(&key, "InfSection")?,
    ))
}

fn optional_value<T: winreg::types::FromRegValue + Default>(
    key: &RegKey,
    name: &str,
) -> std::io::Result<T> {
    match key.get_value(name) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        result => result,
    }
}

fn active_recovery_bindings() -> std::io::Result<HashSet<String>> {
    let root = match RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(BINDINGS) {
        Ok(key) => key,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(e) => return Err(e),
    };
    let mut active = HashSet::new();
    for name in root.enum_keys() {
        let key = root.open_subkey(name?)?;
        let valid: u32 = optional_value(&key, "Valid")?;
        let enabled: u32 = optional_value(&key, "Active")?;
        if valid != 0 && enabled != 0 {
            let id: String = key.get_value("InstanceId")?;
            active.insert(id.to_ascii_uppercase());
        }
    }
    Ok(active)
}

fn universal_package(bytes: &[u8]) -> bool {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        let units: Vec<_> = bytes[2..]
            .chunks_exact(2)
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines().any(|line| {
        line.split(';')
            .next()
            .unwrap_or_default()
            .split(['=', ',', ' ', '\t', '"', '\\', '/'])
            .any(|token| token.eq_ignore_ascii_case("QuarborUniversalKeyboardDriver.dll"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "read-only enumeration of live Windows PnP nodes"]
    fn present_inventory_excludes_historical_nodes() {
        let expected: HashSet<_> = list()
            .unwrap()
            .into_iter()
            .filter(|device| device.present)
            .map(|device| device.instance_id)
            .collect();
        let actual = list_present().unwrap();
        assert!(actual.iter().all(|device| device.present));
        assert_eq!(
            actual
                .into_iter()
                .map(|device| device.instance_id)
                .collect::<HashSet<_>>(),
            expected
        );
    }

    #[test]
    fn recognizes_package_identity_not_generic_umdf_service_or_section() {
        assert!(universal_package(
            b"[SourceDisksFiles]\nQuarborUniversalKeyboardDriver.dll=1"
        ));
        assert!(!universal_package(
            b"[BleKeyboard.NT.Services]\nAddService=mshidumdf\n;QuarborUniversalKeyboardDriver.dll"
        ));
        assert!(!universal_package(b"QuarborHIDFilterUserDriver.dll=1"));
        assert!(!universal_package(
            b"OtherQuarborUniversalKeyboardDriver.dll=1"
        ));
        let wide: Vec<_> = [0xff, 0xfe]
            .into_iter()
            .chain(
                "quarboruniversalkeyboarddriver.dll=1"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes),
            )
            .collect();
        assert!(universal_package(&wide));
    }
    #[test]
    fn includes_hid_children_and_ble_parents_but_not_generated_output_nodes() {
        assert!(is_input_node(
            r"HID\VID_2717&PID_32B8\child",
            KEYBOARD_CLASS
        ));
        assert!(is_input_node(
            r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&012717_PID&32B8\parent",
            GUID::zeroed()
        ));
        assert!(!is_input_node(
            r"ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\0000",
            HID_CLASS
        ));
        assert!(!is_input_node(r"PCI\unrelated", GUID::zeroed()));
    }
    #[test]
    #[ignore = "read-only comparison with the bundled installer and live Windows PnP"]
    fn native_inventory_matches_installer() {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let exe = crate::quarbor_installer::find(resources).unwrap();
        let expected = crate::quarbor_installer::invoke(&exe, "list", None, None)
            .unwrap()
            .devices;
        let actual = list().unwrap();
        for device in &expected {
            let found = actual
                .iter()
                .find(|d| d.instance_id.eq_ignore_ascii_case(&device.instance_id))
                .unwrap_or_else(|| panic!("missing {}", device.instance_id));
            assert_eq!(
                (found.present, found.bound, found.recovery_active),
                (device.present, device.bound, device.recovery_active),
                "{}",
                device.instance_id
            );
            assert!(
                found.inf.eq_ignore_ascii_case(&device.inf),
                "{} INF",
                device.instance_id
            );
            assert!(
                found.section.eq_ignore_ascii_case(&device.section),
                "{} section",
                device.instance_id
            );
        }
        eprintln!(
            "Verified {} installer devices against {} native devices",
            expected.len(),
            actual.len()
        );
    }
}
