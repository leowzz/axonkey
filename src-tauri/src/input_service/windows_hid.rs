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
                HidD_FreePreparsedData, HidD_GetHidGuid, HidD_GetPreparsedData, HidP_GetButtonCaps,
                HidP_GetCaps, HidP_GetUsages, HidP_Input, HidP_MaxUsageListLength,
                HIDP_BUTTON_CAPS, HIDP_CAPS, HIDP_STATUS_SUCCESS, PHIDP_PREPARSED_DATA,
            },
        },
        Foundation::{GetLastError, HANDLE},
    },
};

pub(super) struct KeyboardDescriptor(PHIDP_PREPARSED_DATA);

#[derive(Default)]
pub(super) struct KeyBindings(Vec<HIDP_BUTTON_CAPS>);

impl KeyBindings {
    /// Match InputQueue::FindBinding: a usage must resolve to one report and
    /// link collection, and the report must be advertised by Capabilities.
    pub fn supports(&self, page: u16, usage: u16, reports: &[u8; 32]) -> bool {
        let mut found = None;
        for cap in &self.0 {
            let contains = unsafe {
                if cap.IsRange {
                    (cap.Anonymous.Range.UsageMin..=cap.Anonymous.Range.UsageMax).contains(&usage)
                } else {
                    cap.Anonymous.NotRange.Usage == usage
                }
            };
            if cap.UsagePage != page || !contains {
                continue;
            }
            let binding = (cap.ReportID, cap.LinkCollection);
            if found.is_some_and(|previous| previous != binding) {
                return false;
            }
            found = Some(binding);
        }
        found.is_some_and(|(id, _)| reports[id as usize / 8] & (1 << (id % 8)) != 0)
    }

    #[cfg(test)]
    pub fn keyboard_fixture(usages: &[u16]) -> Self {
        Self(
            usages
                .iter()
                .map(|usage| {
                    let mut cap = HIDP_BUTTON_CAPS {
                        UsagePage: 7,
                        ReportID: 1,
                        ..Default::default()
                    };
                    cap.Anonymous.NotRange.Usage = *usage;
                    cap
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injection_bindings_match_ranges_report_ids_and_unique_collections() {
        let mut reports = [0; 32];
        reports[0] = 2;
        let mut range = HIDP_BUTTON_CAPS {
            UsagePage: 7,
            ReportID: 1,
            IsRange: true,
            ..Default::default()
        };
        range.Anonymous.Range.UsageMin = 4;
        range.Anonymous.Range.UsageMax = 0x73;
        let bindings = KeyBindings(vec![range]);
        assert!(bindings.supports(7, 4, &reports));
        assert!(bindings.supports(7, 0x73, &reports));
        assert!(!bindings.supports(7, 0x74, &reports));
        assert!(!bindings.supports(0x0c, 4, &reports));
        assert!(!bindings.supports(7, 4, &[0; 32]));
        assert!(KeyBindings(vec![range, range]).supports(7, 4, &reports));
        let mut ambiguous = range;
        ambiguous.LinkCollection = 1;
        assert!(!KeyBindings(vec![range, ambiguous]).supports(7, 4, &reports));
        ambiguous = range;
        ambiguous.ReportID = 2;
        reports[0] |= 4;
        assert!(!KeyBindings(vec![range, ambiguous]).supports(7, 4, &reports));
        let single = KeyBindings::keyboard_fixture(&[0xe6]);
        assert!(single.supports(7, 0xe6, &reports));
        assert!(!single.supports(7, 0xe2, &reports));
    }
}

impl Drop for KeyboardDescriptor {
    fn drop(&mut self) {
        unsafe {
            HidD_FreePreparsedData(self.0);
        }
    }
}

impl KeyboardDescriptor {
    pub fn key_bindings(&self) -> Result<KeyBindings, u32> {
        let mut caps = HIDP_CAPS::default();
        let status = unsafe { HidP_GetCaps(self.0, &mut caps) };
        if status != HIDP_STATUS_SUCCESS {
            return Err(status.0 as u32);
        }
        let mut count = caps.NumberInputButtonCaps;
        if count == 0 {
            return Ok(KeyBindings::default());
        }
        let mut buttons = vec![HIDP_BUTTON_CAPS::default(); count as usize];
        let status =
            unsafe { HidP_GetButtonCaps(HidP_Input, buttons.as_mut_ptr(), &mut count, self.0) };
        if status != HIDP_STATUS_SUCCESS {
            return Err(status.0 as u32);
        }
        if count as usize > buttons.len() {
            return Err(13);
        }
        buttons.truncate(count as usize);
        Ok(KeyBindings(buttons))
    }

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
