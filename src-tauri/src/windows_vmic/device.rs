use std::mem::size_of;

use windows::{
    core::{w, Error, PCWSTR},
    Win32::{
        Devices::{
            DeviceAndDriverInstallation::{
                SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
                SetupDiGetDeviceInstanceIdW, SetupDiGetDevicePropertyW,
                SetupDiGetDeviceRegistryPropertyW, DIGCF_ALLCLASSES, HDEVINFO, SPDRP_HARDWAREID,
                SP_DEVINFO_DATA,
            },
            Properties::{
                DEVPKEY_Device_MatchingDeviceId, DEVPKEY_Device_Parent, DEVPROPTYPE,
                DEVPROP_TYPE_STRING,
            },
        },
        Foundation::{
            CloseHandle, DEVPROPKEY, ERROR_DEV_NOT_EXIST, ERROR_FILE_NOT_FOUND,
            ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_DATA, ERROR_NOT_FOUND, ERROR_NO_MORE_ITEMS,
            ERROR_NO_SUCH_DEVINST, GENERIC_READ, GENERIC_WRITE, HANDLE,
        },
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::IO::DeviceIoControl,
    },
};

const PROTOCOL_VERSION: u32 = 1;
const IOCTL_VMIC_GET_STATUS: u32 = 0x8337_6008;
const IOCTL_VMIC_WRITE_PCM: u32 = 0x8337_A005;
const IOCTL_VMIC_FLUSH: u32 = 0x8337_A00C;
const HARDWARE_ID: &str = r"ROOT\QUARBORVIRTUALMICROPHONE";
const MAX_PROPERTY_BYTES: u32 = 1_048_576;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PcmFormat {
    pub sample_rate: u32,
    pub bits_per_sample: u16,
    pub channels: u16,
}

impl PcmFormat {
    pub(crate) fn frame_bytes(self) -> u32 {
        u32::from(self.channels) * u32::from(self.bits_per_sample) / 8
    }

    fn is_supported(self) -> bool {
        matches!(
            self.sample_rate,
            8_000 | 16_000 | 24_000 | 32_000 | 44_100 | 48_000 | 96_000 | 192_000
        ) && matches!(self.bits_per_sample, 16 | 24)
            && matches!(self.channels, 1 | 2)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DriverStatus {
    pub size: u32,
    pub protocol_version: u32,
    pub driver_version_major: u16,
    pub driver_version_minor: u16,
    pub driver_version_build: u16,
    pub driver_version_revision: u16,
    pub capture_active: u32,
    pub capture_state: u32,
    pub format: PcmFormat,
    pub frame_bytes: u32,
    pub fifo_capacity_bytes: u32,
    pub fifo_queued_bytes: u32,
    pub fifo_free_bytes: u32,
    pub fifo_overflow_bytes: u32,
    pub wave_rt_buffer_bytes: u32,
    pub wave_rt_buffer_duration_ms: u32,
    pub last_write_bytes: u32,
    pub last_io_status: i32,
    pub reserved: [u32; 4],
}

impl DriverStatus {
    pub(crate) fn is_running(self) -> bool {
        self.capture_active == 1 && self.capture_state == 3
    }

    fn validate(&self, returned_bytes: u32) -> Result<(), String> {
        if returned_bytes < size_of::<Self>() as u32
            || self.size < size_of::<Self>() as u32
            || self.protocol_version != PROTOCOL_VERSION
        {
            return Err(
                "Quarbor virtual microphone returned an incompatible status protocol".into(),
            );
        }
        if self.format == PcmFormat::default() && !self.is_running() {
            return Ok(());
        }
        if !self.format.is_supported() || self.frame_bytes != self.format.frame_bytes() {
            return Err(format!(
                "Quarbor virtual microphone returned an unsupported PCM format: {:?}",
                self.format
            ));
        }
        Ok(())
    }
}

#[repr(C)]
#[derive(Debug)]
struct WritePcmRequest {
    size: u32,
    protocol_version: u32,
    data_bytes: u32,
    format: PcmFormat,
    flags: u32,
}

pub(super) struct Device(HANDLE);

impl Device {
    pub(super) fn open() -> Result<Self, String> {
        unsafe {
            CreateFileW(
                w!(r"\\.\QuarborVirtualMicrophone"),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .map(Self)
        .map_err(|error| format!("Cannot open Quarbor virtual microphone: {error}"))
    }

    pub(super) fn status(&self) -> Result<DriverStatus, String> {
        let mut status = DriverStatus::default();
        let mut returned_bytes = 0;
        unsafe {
            DeviceIoControl(
                self.0,
                IOCTL_VMIC_GET_STATUS,
                None,
                0,
                Some((&mut status as *mut DriverStatus).cast()),
                size_of::<DriverStatus>() as u32,
                Some(&mut returned_bytes),
                None,
            )
        }
        .map_err(|error| format!("Cannot query Quarbor virtual microphone status: {error}"))?;
        status.validate(returned_bytes)?;
        Ok(status)
    }

    pub(super) fn flush(&self) -> Result<(), String> {
        let mut returned_bytes = 0;
        unsafe {
            DeviceIoControl(
                self.0,
                IOCTL_VMIC_FLUSH,
                None,
                0,
                None,
                0,
                Some(&mut returned_bytes),
                None,
            )
        }
        .map_err(|error| format!("Cannot flush Quarbor virtual microphone audio: {error}"))
    }

    pub(super) fn write_pcm(&self, pcm: &[u8], format: PcmFormat) -> Result<(), String> {
        let request = WritePcmRequest {
            size: size_of::<WritePcmRequest>() as u32,
            protocol_version: PROTOCOL_VERSION,
            data_bytes: pcm.len() as u32,
            format,
            flags: 0,
        };
        let mut returned_bytes = 0;
        // METHOD_IN_DIRECT reads PCM from lpOutBuffer; bytes returned is always zero.
        unsafe {
            DeviceIoControl(
                self.0,
                IOCTL_VMIC_WRITE_PCM,
                Some((&request as *const WritePcmRequest).cast()),
                size_of::<WritePcmRequest>() as u32,
                Some(pcm.as_ptr().cast_mut().cast()),
                request.data_bytes,
                Some(&mut returned_bytes),
                None,
            )
        }
        .map_err(|error| format!("Cannot write Quarbor virtual microphone PCM: {error}"))
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct DeviceSet(HDEVINFO);

impl Drop for DeviceSet {
    fn drop(&mut self) {
        unsafe {
            let _ = SetupDiDestroyDeviceInfoList(self.0);
        }
    }
}

pub(super) fn is_installed() -> Result<bool, String> {
    probe_installation().map_err(|error| {
        format!("Cannot enumerate installed Quarbor virtual microphone devices: {error}")
    })
}

fn probe_installation() -> windows::core::Result<bool> {
    let set = match unsafe { SetupDiGetClassDevsW(None, PCWSTR::null(), None, DIGCF_ALLCLASSES) } {
        Ok(set) => DeviceSet(set),
        Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => return Ok(false),
        Err(error) => return Err(error),
    };
    for index in 0.. {
        let mut info = SP_DEVINFO_DATA {
            cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        match unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut info) } {
            Ok(()) => {}
            Err(error) if error.code() == ERROR_NO_MORE_ITEMS.to_hresult() => return Ok(false),
            Err(error) => return Err(error),
        }
        match device_matches(&set, &info) {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error)
                if error.code() == ERROR_NO_SUCH_DEVINST.to_hresult()
                    || error.code() == ERROR_DEV_NOT_EXIST.to_hresult() => {}
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

fn device_matches(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> windows::core::Result<bool> {
    let hardware_ids = hardware_ids(set, info)?;
    let instance_id = instance_id(set, info)?;
    let matching_id = string_property(set, info, &DEVPKEY_Device_MatchingDeviceId)?;
    let parent = string_property(set, info, &DEVPKEY_Device_Parent)?;
    Ok(matches_identifiers(
        &hardware_ids,
        &instance_id,
        &matching_id,
        &parent,
    ))
}

fn matches_identifiers(
    hardware_ids: &str,
    instance_id: &str,
    matching_id: &str,
    parent: &str,
) -> bool {
    let prefix = format!("{HARDWARE_ID}\\");
    hardware_ids
        .split('\0')
        .any(|id| id.eq_ignore_ascii_case(HARDWARE_ID))
        || matching_id.eq_ignore_ascii_case(HARDWARE_ID)
        || instance_id.to_ascii_uppercase().starts_with(&prefix)
        // An orphaned child still counts as installed, as in Installer.cpp.
        || parent.to_ascii_uppercase().starts_with(&prefix)
}

fn hardware_ids(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> windows::core::Result<String> {
    let mut size = 0;
    let mut kind = 0;
    match unsafe {
        SetupDiGetDeviceRegistryPropertyW(
            set.0,
            info,
            SPDRP_HARDWAREID,
            Some(&mut kind),
            None,
            Some(&mut size),
        )
    } {
        Err(error)
            if error.code() == ERROR_INVALID_DATA.to_hresult()
                || error.code() == ERROR_NOT_FOUND.to_hresult() =>
        {
            return Ok(String::new());
        }
        Err(error) if error.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() => return Err(error),
        _ => {}
    }
    let mut bytes = property_buffer(size)?;
    unsafe {
        SetupDiGetDeviceRegistryPropertyW(
            set.0,
            info,
            SPDRP_HARDWAREID,
            Some(&mut kind),
            Some(&mut bytes),
            Some(&mut size),
        )
    }?;
    // REG_SZ, REG_EXPAND_SZ and REG_MULTI_SZ, preserving all hardware IDs.
    if !matches!(kind, 1 | 2 | 7) {
        return Ok(String::new());
    }
    utf16_property(&bytes[..size as usize])
}

fn instance_id(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> windows::core::Result<String> {
    let mut size = 0;
    match unsafe { SetupDiGetDeviceInstanceIdW(set.0, info, None, Some(&mut size)) } {
        Err(error) if error.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() => return Err(error),
        _ => {}
    }
    let mut units = vec![0; size as usize];
    unsafe { SetupDiGetDeviceInstanceIdW(set.0, info, Some(&mut units), None) }?;
    Ok(String::from_utf16_lossy(&units)
        .trim_end_matches('\0')
        .into())
}

fn string_property(
    set: &DeviceSet,
    info: &SP_DEVINFO_DATA,
    key: &DEVPROPKEY,
) -> windows::core::Result<String> {
    let mut size = 0;
    let mut kind = DEVPROPTYPE::default();
    match unsafe {
        SetupDiGetDevicePropertyW(set.0, info, key, &mut kind, None, Some(&mut size), 0)
    } {
        Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => return Ok(String::new()),
        Err(error) if error.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() => return Err(error),
        _ => {}
    }
    let mut bytes = property_buffer(size)?;
    unsafe {
        SetupDiGetDevicePropertyW(
            set.0,
            info,
            key,
            &mut kind,
            Some(&mut bytes),
            Some(&mut size),
            0,
        )
    }?;
    if kind != DEVPROP_TYPE_STRING {
        return Ok(String::new());
    }
    Ok(utf16_property(&bytes[..size as usize])?
        .trim_end_matches('\0')
        .into())
}

fn property_buffer(size: u32) -> windows::core::Result<Vec<u8>> {
    if size > MAX_PROPERTY_BYTES || size % 2 != 0 {
        return Err(Error::from_hresult(ERROR_INVALID_DATA.to_hresult()));
    }
    Ok(vec![0; size as usize])
}

fn utf16_property(bytes: &[u8]) -> windows::core::Result<String> {
    if bytes.len() % 2 != 0 {
        return Err(Error::from_hresult(ERROR_INVALID_DATA.to_hresult()));
    }
    let units: Vec<_> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Ok(String::from_utf16_lossy(&units))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_layout_matches_driver_abi() {
        assert_eq!(size_of::<PcmFormat>(), 8);
        assert_eq!(std::mem::align_of::<PcmFormat>(), 4);
        assert_eq!(size_of::<WritePcmRequest>(), 24);
        assert_eq!(std::mem::offset_of!(WritePcmRequest, format), 12);
        assert_eq!(std::mem::offset_of!(WritePcmRequest, flags), 20);
        assert_eq!(size_of::<DriverStatus>(), 84);
        assert_eq!(std::mem::offset_of!(DriverStatus, format), 24);
        assert_eq!(std::mem::offset_of!(DriverStatus, last_io_status), 64);
    }

    #[test]
    fn installation_matches_secondary_hardware_ids_and_orphaned_children() {
        assert!(matches_identifiers(
            "other\0root\\quarborvirtualmicrophone\0\0",
            "unrelated",
            "",
            ""
        ));
        assert!(matches_identifiers(
            "",
            "",
            "ROOT\\QUARBORVIRTUALMICROPHONE",
            ""
        ));
        assert!(matches_identifiers(
            "",
            "root\\quarborvirtualmicrophone\\0000",
            "",
            ""
        ));
        assert!(matches_identifiers(
            "",
            "SWD\\MMDEVAPI\\endpoint",
            "",
            "ROOT\\QUARBORVIRTUALMICROPHONE\\0000"
        ));
        assert!(!matches_identifiers(
            "ROOT\\QUARBORVIRTUALMICROPHONEOTHER\0",
            "ROOT\\QUARBORVIRTUALMICROPHONEOTHER\\0000",
            "",
            ""
        ));
    }

    #[test]
    fn validates_status_at_driver_boundary() {
        let mut status = DriverStatus {
            size: 84,
            protocol_version: PROTOCOL_VERSION,
            ..Default::default()
        };
        assert!(status.validate(84).is_ok());
        status.capture_active = 1;
        status.capture_state = 3;
        assert!(status.validate(84).is_err());
        status.format = PcmFormat {
            sample_rate: 44_100,
            bits_per_sample: 24,
            channels: 2,
        };
        status.frame_bytes = 6;
        assert!(status.validate(84).is_ok());
        assert!(status.validate(80).is_err());
        status.frame_bytes = 4;
        assert!(status.validate(84).is_err());
        status.frame_bytes = 6;
        status.protocol_version = 2;
        assert!(status.validate(84).is_err());
    }
}
