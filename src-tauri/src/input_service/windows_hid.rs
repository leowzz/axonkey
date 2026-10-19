//! Parse pipe-delivered HID bytes with Windows' actual device descriptor.
//! Device handles request metadata access only; physical input is never read here.
use std::{
    fs::OpenOptions,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Devices::{
            DeviceAndDriverInstallation::{
                CM_Get_Device_Interface_ListW, CM_Get_Device_Interface_List_SizeW,
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT, CR_SUCCESS,
            },
            HumanInterfaceDevice::{
                HidD_FreePreparsedData, HidD_GetHidGuid, HidD_GetPreparsedData, HidP_GetCaps,
                HidP_GetUsages, HidP_Input, HidP_MaxUsageListLength, HIDP_CAPS,
                HIDP_STATUS_SUCCESS, PHIDP_PREPARSED_DATA,
            },
        },
        Foundation::{GetLastError, HANDLE},
    },
};

pub(super) struct KeyboardDescriptor(PHIDP_PREPARSED_DATA);

impl Drop for KeyboardDescriptor {
    fn drop(&mut self) {
        unsafe {
            HidD_FreePreparsedData(self.0);
        }
    }
}

impl KeyboardDescriptor {
    pub fn load(instance_id: &str) -> Result<Self, u32> {
        let instance: Vec<u16> = instance_id.encode_utf16().chain(Some(0)).collect();
        let guid = unsafe { HidD_GetHidGuid() };
        let mut error = 1168; // ERROR_NOT_FOUND
        for _ in 0..3 {
            let mut length = 0;
            if unsafe {
                CM_Get_Device_Interface_List_SizeW(
                    &mut length,
                    &guid,
                    PCWSTR(instance.as_ptr()),
                    CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
                )
            } != CR_SUCCESS
                || !(2..=1_000_000).contains(&length)
            {
                return Err(error);
            }
            let mut paths = vec![0u16; length as usize];
            if unsafe {
                CM_Get_Device_Interface_ListW(
                    &guid,
                    PCWSTR(instance.as_ptr()),
                    &mut paths,
                    CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
                )
            } != CR_SUCCESS
            {
                continue;
            }
            for path in paths
                .split(|unit| *unit == 0)
                .take_while(|path| !path.is_empty())
            {
                use std::os::windows::ffi::OsStringExt;
                let path = std::ffi::OsString::from_wide(path);
                let file = match OpenOptions::new().access_mode(0).share_mode(3).open(path) {
                    Ok(file) => file,
                    Err(failure) => {
                        error = failure.raw_os_error().unwrap_or(1168) as u32;
                        continue;
                    }
                };
                let mut data = PHIDP_PREPARSED_DATA::default();
                if !unsafe { HidD_GetPreparsedData(HANDLE(file.as_raw_handle()), &mut data) } {
                    error = unsafe { GetLastError() }.0;
                    continue;
                }
                let descriptor = Self(data);
                let mut caps = HIDP_CAPS::default();
                if unsafe { HidP_GetCaps(data, &mut caps) } == HIDP_STATUS_SUCCESS
                    && caps.UsagePage == 1
                    && caps.Usage == 6
                {
                    return Ok(descriptor);
                }
                error = 50; // ERROR_NOT_SUPPORTED; descriptor freed by Drop.
            }
            return Err(error);
        }
        Err(error)
    }

    pub fn usages(&self, bytes: &[u8]) -> Result<Vec<u16>, u32> {
        let mut length = unsafe { HidP_MaxUsageListLength(HidP_Input, Some(0x07), self.0) };
        if !(1..=32768).contains(&length) {
            return Err(13);
        } // ERROR_INVALID_DATA
        let mut usages = vec![0; length as usize];
        // The Windows binding takes mutable report memory. Preserve the raw event.
        let mut report = bytes.to_vec();
        let status = unsafe {
            HidP_GetUsages(
                HidP_Input,
                0x07,
                None,
                usages.as_mut_ptr(),
                &mut length,
                self.0,
                &mut report,
            )
        };
        if status != HIDP_STATUS_SUCCESS {
            return Err(status.0 as u32);
        }
        if length > 256 || length as usize > usages.len() {
            return Err(122);
        }
        usages.truncate(length as usize);
        Ok(usages)
    }
}
