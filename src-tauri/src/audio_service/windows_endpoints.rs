//! Read-only MMDevice / DeviceTopology / Configuration Manager discovery.
//! Display names and the undocumented MMDevices registry layout never identify
//! a driver. COM values and task-allocated strings are owned by scoped guards.

use super::endpoint_selection::{is_supported_adapter, AudioEndpoint};
use std::collections::HashMap;
use windows::{
    core::{HRESULT, PCWSTR, PWSTR},
    Win32::{
        Devices::{
            DeviceAndDriverInstallation::{
                CM_Get_DevNode_PropertyW, CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_PHANTOM,
                CR_BUFFER_SMALL, CR_SUCCESS,
            },
            FunctionDiscovery::{PKEY_Device_FriendlyName, PKEY_Device_InstanceId},
            Properties::{
                DEVPKEY_Device_HardwareIds, DEVPKEY_Device_Parent, DEVPKEY_Device_Service,
                DEVPROPTYPE, DEVPROP_TYPE_STRING, DEVPROP_TYPE_STRING_LIST,
            },
        },
        Foundation::{
            DEVPROPKEY, ERROR_NOT_FOUND, ERROR_NO_SUCH_DEVICE_INTERFACE, PROPERTYKEY,
            RPC_E_CHANGED_MODE, SPAPI_E_NO_SUCH_DEVICE_INTERFACE,
        },
        Media::Audio::{
            eCapture, eRender, IDeviceTopology, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
            PKEY_AudioEndpoint_FormFactor, PKEY_AudioEngine_DeviceFormat, DEVICE_STATE,
            DEVICE_STATEMASK_ALL, DEVICE_STATE_ACTIVE, DEVICE_STATE_DISABLED,
            DEVICE_STATE_NOTPRESENT, DEVICE_STATE_UNPLUGGED,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                StructuredStorage::{PropVariantClear, PropVariantToStringAlloc, PROPVARIANT},
                CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
            },
            Variant::{VT_BLOB, VT_UI4},
        },
        UI::Shell::PropertiesSystem::IPropertyStore,
    },
};

struct ComApartment(bool);

impl ComApartment {
    fn initialize() -> Result<Self, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result.is_ok() {
            // Both S_OK and S_FALSE acquire a COM initialization reference.
            Ok(Self(true))
        } else if result == RPC_E_CHANGED_MODE {
            // The caller already initialized this thread in a different model.
            Ok(Self(false))
        } else {
            Err(format!("初始化音频设备查询失败：{result}"))
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

struct OwnedPropVariant(PROPVARIANT);

impl Drop for OwnedPropVariant {
    fn drop(&mut self) {
        unsafe {
            let _ = PropVariantClear(&mut self.0);
        }
    }
}

/// Consume a string returned by an API that transfers CoTaskMem ownership.
fn take_com_string(value: PWSTR) -> Result<String, String> {
    if value.is_null() {
        return Err("Windows 返回了空设备属性。".into());
    }
    let result = unsafe { value.to_string() }
        .map_err(|error| format!("设备属性不是有效的 Unicode：{error}"));
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    result
}

fn string_property(store: &IPropertyStore, key: &PROPERTYKEY) -> Result<String, String> {
    let value =
        OwnedPropVariant(unsafe { store.GetValue(key) }.map_err(|error| error.to_string())?);
    let text = unsafe { PropVariantToStringAlloc(&value.0) }.map_err(|error| error.to_string())?;
    take_com_string(text)
}

// Shared format is descriptive metadata only; inability to read it does not
// exclude a candidate, and channel count never decides which port is selected.
fn channels(store: &IPropertyStore) -> Option<u16> {
    let value = OwnedPropVariant(unsafe { store.GetValue(&PKEY_AudioEngine_DeviceFormat) }.ok()?);
    unsafe {
        let inner = &value.0.Anonymous.Anonymous;
        if inner.vt != VT_BLOB {
            return None;
        }
        let blob = inner.Anonymous.blob;
        if blob.cbSize < 4 || blob.pBlobData.is_null() {
            return None;
        }
        // WAVEFORMATEX starts with two little-endian WORDs: format, channels.
        let bytes = std::slice::from_raw_parts(blob.pBlobData, 4);
        let count = u16::from_le_bytes([bytes[2], bytes[3]]);
        (count > 0).then_some(count)
    }
}

fn form_factor(store: &IPropertyStore) -> Option<u32> {
    let value = OwnedPropVariant(unsafe { store.GetValue(&PKEY_AudioEndpoint_FormFactor) }.ok()?);
    unsafe {
        let inner = &value.0.Anonymous.Anonymous;
        if inner.vt != VT_UI4 {
            return None;
        }
        Some(inner.Anonymous.uintVal)
    }
}

fn pnp_property(devnode: u32, key: &DEVPROPKEY, expected: DEVPROPTYPE) -> Result<Vec<u16>, String> {
    let mut kind = DEVPROPTYPE::default();
    let mut size = 0;
    let result = unsafe { CM_Get_DevNode_PropertyW(devnode, key, &mut kind, None, &mut size, 0) };
    if result != CR_BUFFER_SMALL && result != CR_SUCCESS {
        return Err(format!("读取适配器身份属性失败（CM 0x{:X}）。", result.0));
    }
    // Bound allocation and retry if the driver changes the value between reads.
    for _ in 0..3 {
        if size == 0 || size > 1024 * 1024 || size % 2 != 0 {
            return Err("适配器身份属性的长度无效。".into());
        }
        let mut buffer = vec![0u16; size as usize / 2];
        let result = unsafe {
            CM_Get_DevNode_PropertyW(
                devnode,
                key,
                &mut kind,
                Some(buffer.as_mut_ptr().cast()),
                &mut size,
                0,
            )
        };
        if result == CR_BUFFER_SMALL {
            continue;
        }
        if result != CR_SUCCESS {
            return Err(format!("读取适配器身份属性失败（CM 0x{:X}）。", result.0));
        }
        if kind != expected || size % 2 != 0 || size as usize / 2 > buffer.len() {
            return Err("适配器身份属性的类型或长度无效。".into());
        }
        buffer.truncate(size as usize / 2);
        return Ok(buffer);
    }
    Err("适配器身份属性正在变化，请重新检测。".into())
}

fn decode_strings(value: &[u16], multi: bool) -> Result<Vec<String>, String> {
    if value.last() != Some(&0) || (multi && (value.len() < 2 || value[value.len() - 2] != 0)) {
        return Err("适配器身份字符串缺少结束标记。".into());
    }
    let values: Vec<_> = value
        .split(|character| *character == 0)
        .filter(|part| !part.is_empty())
        .map(String::from_utf16)
        .collect::<Result<_, _>>()
        .map_err(|error| format!("适配器身份字符串无效：{error}"))?;
    if !multi && values.len() != 1 {
        return Err("适配器服务身份无效。".into());
    }
    Ok(values)
}

#[derive(Clone)]
struct AdapterIdentity {
    instance_id: String,
    hardware_ids: Vec<String>,
    service: String,
}

fn topology_adapter_instance(
    endpoint: &IMMDevice,
    enumerator: &IMMDeviceEnumerator,
) -> Result<Option<String>, String> {
    let topology: IDeviceTopology = unsafe { endpoint.Activate(CLSCTX_ALL, None) }
        .map_err(|error| format!("读取音频端点拓扑失败：{error}"))?;
    let count = unsafe { topology.GetConnectorCount() }
        .map_err(|error| format!("读取音频端点连接信息失败：{error}"))?;
    // An endpoint topology has one connector. Do not guess if a driver reports
    // a topology whose adapter association cannot be established uniquely.
    if count != 1 {
        return Err("无法确定音频端点的唯一父适配器。".into());
    }
    let connector = unsafe { topology.GetConnector(0) }
        .map_err(|error| format!("读取音频端点连接失败：{error}"))?;
    let adapter_device_id = match unsafe { connector.GetDeviceIdConnectedTo() } {
        Ok(value) => take_com_string(value)?,
        Err(error)
            if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0)
                && unsafe { endpoint.GetState() }.ok() == Some(DEVICE_STATE_NOTPRESENT) =>
        {
            // An uninstalled device may leave a phantom endpoint with no
            // connected adapter. Windows explicitly reports absence here,
            // not a failed identity-property read. A saved ID stays unavailable.
            return Ok(None);
        }
        Err(error) => return Err(format!("读取父音频适配器失败：{error}")),
    };
    let wide_id: Vec<u16> = adapter_device_id.encode_utf16().chain(Some(0)).collect();
    let adapter = match unsafe { enumerator.GetDevice(PCWSTR(wide_id.as_ptr())) } {
        Ok(adapter) => adapter,
        Err(error)
            if (error.code() == HRESULT(ERROR_NO_SUCH_DEVICE_INTERFACE.0 as i32)
                || error.code() == SPAPI_E_NO_SUCH_DEVICE_INTERFACE)
                && unsafe { endpoint.GetState() }.ok() == Some(DEVICE_STATE_NOTPRESENT) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(format!("打开父音频适配器信息失败：{error}")),
    };
    let store = unsafe { adapter.OpenPropertyStore(STGM_READ) }
        .map_err(|error| format!("读取父音频适配器属性失败：{error}"))?;
    let instance_id = string_property(&store, &PKEY_Device_InstanceId)
        .map_err(|error| format!("读取适配器实例标识失败：{error}"))?;
    Ok(Some(instance_id))
}

fn locate_devnode(instance_id: &str) -> Result<u32, String> {
    if instance_id.is_empty() {
        return Err("父音频适配器缺少实例标识。".into());
    }
    let wide_instance: Vec<u16> = instance_id.encode_utf16().chain(Some(0)).collect();
    let mut devnode = 0;
    let result = unsafe {
        CM_Locate_DevNodeW(
            &mut devnode,
            PCWSTR(wide_instance.as_ptr()),
            CM_LOCATE_DEVNODE_PHANTOM,
        )
    };
    if result != CR_SUCCESS {
        return Err(format!("定位父音频适配器失败（CM 0x{:X}）。", result.0));
    }
    Ok(devnode)
}

fn pnp_parent_instance(endpoint: &IMMDevice) -> Result<String, String> {
    // Disconnected and software endpoints can have no connected topology
    // connector. The documented PnP parent property also preserves the last
    // parent for non-present devices, so their identity/state remains visible.
    let store = unsafe { endpoint.OpenPropertyStore(STGM_READ) }
        .map_err(|error| format!("读取音频端点实例失败：{error}"))?;
    let instance_id = string_property(&store, &PKEY_Device_InstanceId)?;
    let devnode = locate_devnode(&instance_id)?;
    decode_strings(
        &pnp_property(devnode, &DEVPKEY_Device_Parent, DEVPROP_TYPE_STRING)?,
        false,
    )?
    .into_iter()
    .next()
    .ok_or_else(|| "音频端点缺少父设备标识。".into())
}

fn adapter_identity(
    endpoint: &IMMDevice,
    enumerator: &IMMDeviceEnumerator,
    cache: &mut HashMap<String, Option<AdapterIdentity>>,
) -> Result<Option<AdapterIdentity>, String> {
    let Some(instance_id) =
        topology_adapter_instance(endpoint, enumerator).or_else(|topology_error| {
            pnp_parent_instance(endpoint)
                .map(Some)
                .map_err(|parent_error| format!("{topology_error}；{parent_error}"))
        })?
    else {
        return Ok(None);
    };
    if let Some(identity) = cache.get(&instance_id) {
        return Ok(identity.clone());
    }
    let devnode = locate_devnode(&instance_id)?;
    let hardware_ids = decode_strings(
        &pnp_property(
            devnode,
            &DEVPKEY_Device_HardwareIds,
            DEVPROP_TYPE_STRING_LIST,
        )?,
        true,
    )?;
    if !hardware_ids
        .iter()
        .any(|id| id.eq_ignore_ascii_case("VBAudioVACWDM"))
    {
        cache.insert(instance_id, None);
        return Ok(None);
    }
    let service = decode_strings(
        &pnp_property(devnode, &DEVPKEY_Device_Service, DEVPROP_TYPE_STRING)?,
        false,
    )?
    .into_iter()
    .next()
    .ok_or("父音频适配器缺少服务标识。")?;
    let identity = is_supported_adapter(&hardware_ids, &service).then_some(AdapterIdentity {
        instance_id: instance_id.clone(),
        hardware_ids,
        service,
    });
    cache.insert(instance_id, identity.clone());
    Ok(identity)
}

pub fn enumerate_endpoints() -> Result<Vec<AudioEndpoint>, String> {
    // Declared first so every COM interface is dropped before CoUninitialize.
    let _apartment = ComApartment::initialize()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|error| format!("创建音频设备枚举器失败：{error}"))?;
    let mut adapters = HashMap::new();
    let mut endpoints = Vec::new();
    for (flow, direction) in [(eRender, "render"), (eCapture, "capture")] {
        let collection =
            unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE(DEVICE_STATEMASK_ALL)) }
                .map_err(|error| format!("枚举音频端点失败：{error}"))?;
        let count = unsafe { collection.GetCount() }.map_err(|error| error.to_string())?;
        for index in 0..count {
            let endpoint = unsafe { collection.Item(index) }.map_err(|error| error.to_string())?;
            let Some(adapter) = adapter_identity(&endpoint, &enumerator, &mut adapters)? else {
                continue;
            };
            let id =
                take_com_string(unsafe { endpoint.GetId() }.map_err(|error| error.to_string())?)?;
            let native_state = unsafe { endpoint.GetState() }.map_err(|error| error.to_string())?;
            let state = match native_state {
                DEVICE_STATE_ACTIVE => "active",
                DEVICE_STATE_DISABLED => "disabled",
                DEVICE_STATE_UNPLUGGED => "unplugged",
                DEVICE_STATE_NOTPRESENT => "notPresent",
                _ => return Err("Windows 返回了未知的音频端点状态。".into()),
            };
            let store = unsafe { endpoint.OpenPropertyStore(STGM_READ) }
                .map_err(|error| format!("读取音频端点属性失败：{error}"))?;
            // A missing label must not change the identity or route.
            let name = string_property(&store, &PKEY_Device_FriendlyName)
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "未命名的 VB-CABLE 端点".into());
            endpoints.push(AudioEndpoint {
                id,
                name,
                direction: direction.into(),
                state: state.into(),
                adapter_id: adapter.instance_id,
                hardware_ids: adapter.hardware_ids,
                service: adapter.service,
                channels: channels(&store),
                form_factor: form_factor(&store),
            });
        }
    }
    // Stable presentation only; selection policy never takes the first item.
    endpoints.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(endpoints)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pnp_strings_require_valid_terminated_utf16() {
        assert_eq!(
            decode_strings(&[65, 0, 66, 0, 0], true).unwrap(),
            ["A", "B"]
        );
        assert_eq!(decode_strings(&[65, 0], false).unwrap(), ["A"]);
        assert!(decode_strings(&[65, 0], true).is_err());
        assert!(decode_strings(&[0xD800, 0], false).is_err());
        assert!(decode_strings(&[65], false).is_err());
    }

    #[test]
    #[ignore = "read-only Windows hardware integration check; run explicitly on a VB-CABLE host"]
    fn enumerate_real_vb_cable_endpoints() {
        let endpoints = enumerate_endpoints().expect("native endpoint enumeration");
        assert!(
            !endpoints.is_empty(),
            "this manual check requires an installed VB-CABLE adapter"
        );
        for endpoint in &endpoints {
            assert!(is_supported_adapter(
                &endpoint.hardware_ids,
                &endpoint.service
            ));
        }
        println!("{}", serde_json::to_string_pretty(&endpoints).unwrap());
    }
}
