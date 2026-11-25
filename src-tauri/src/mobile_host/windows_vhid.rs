//! Quarbor keyboard output availability & standalone Root-enumerated virtual HID
//! fallback installer (`ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE`).
//!
//! - When any Quarbor Universal Keyboard device is ALREADY installed on the PC
//!   (such as Xiaomi RC003 / CMIOT A15), `driver_availability` immediately reports
//!   `installed = true` and reuses that existing driver in-process — ZERO reinstall
//!   and ZERO UAC prompt needed.
//! - Only on a PC that has never had any Quarbor Universal Keyboard device installed
//!   does the user optionally install the standalone `AXONKEYMOBILE` Root-enumerated
//!   output node bound to the existing WHQL/Quarbor-signed `QuarborUniversalKeyboardDriver.inf`.

use std::{
    ffi::c_void,
    mem::size_of,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{w, GUID},
    Win32::{
        Devices::{
            DeviceAndDriverInstallation::{
                SetupDiCreateDeviceInfoList, SetupDiDestroyDeviceInfoList,
                SetupDiGetDevicePropertyW, SetupDiGetDeviceRegistryPropertyW, HDEVINFO,
                SPDRP_DRIVER, SP_DEVINFO_DATA,
            },
            Properties::{DEVPKEY_Device_IsPresent, DEVPROPTYPE},
        },
        Foundation::{
            CloseHandle, GetLastError, ERROR_CANCELLED, ERROR_INSUFFICIENT_BUFFER,
            ERROR_INVALID_DATA, ERROR_NO_SUCH_DEVINST, HANDLE, WAIT_OBJECT_0,
        },
        System::Threading::{GetExitCodeProcess, WaitForSingleObject},
    },
};

pub const MOBILE_VHID_INSTANCE_ID: &str = r"ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE";
const MOBILE_VHID_HARDWARE_ID: &str = r"ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT";
const MOBILE_VHID_DESCRIPTION: &str = "Quarbor Universal Keyboard Output (Axonkey Mobile)";
pub const ADMIN_CLI_FLAG: &str = "--axonkey-mobile-vhid-admin";
pub const UNINSTALL_IF_PRESENT_CLI_FLAG: &str = "--uninstall-mobile-vhid-if-present";
const DRIVER_INF_NAME: &str = "QuarborUniversalKeyboardDriver.inf";

const HID_CLASS: GUID = GUID::from_u128(0x745a17a0_74d3_11d0_b6fe_00a0c90f57da);
const DICD_INHERIT_CLASSDRVS: u32 = 0x0000_0002;
const SPDRP_HARDWAREID_RAW: u32 = 0x0000_0001;
const DIF_REGISTERDEVICE_RAW: u32 = 0x0000_0019;
const SPOST_PATH: u32 = 1;
const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
const SW_HIDE: i32 = 0;

#[link(name = "setupapi")]
unsafe extern "system" {
    fn SetupDiOpenDeviceInfoW(
        device_info_set: isize,
        device_instance_id: *const u16,
        hwnd_parent: *mut c_void,
        open_flags: u32,
        device_info_data: *mut SP_DEVINFO_DATA,
    ) -> i32;

    fn SetupDiCreateDeviceInfoW(
        device_info_set: isize,
        device_name: *const u16,
        class_guid: *const GUID,
        device_description: *const u16,
        hwnd_parent: *mut c_void,
        creation_flags: u32,
        device_info_data: *mut SP_DEVINFO_DATA,
    ) -> i32;

    fn SetupDiSetDeviceRegistryPropertyW(
        device_info_set: isize,
        device_info_data: *mut SP_DEVINFO_DATA,
        property: u32,
        property_buffer: *const u8,
        property_buffer_size: u32,
    ) -> i32;

    fn SetupDiCallClassInstaller(
        install_function: u32,
        device_info_set: isize,
        device_info_data: *mut SP_DEVINFO_DATA,
    ) -> i32;

    fn SetupCopyOEMInfW(
        source_inf_file_name: *const u16,
        oem_source_media_location: *const u16,
        oem_source_media_type: u32,
        copy_style: u32,
        destination_inf_file_name: *mut u16,
        destination_inf_file_name_size: u32,
        required_size: *mut u32,
        destination_inf_file_name_component: *mut *mut u16,
    ) -> i32;
}

#[link(name = "newdev")]
unsafe extern "system" {
    fn DiInstallDevice(
        hwnd_parent: *mut c_void,
        device_info_set: isize,
        device_info_data: *const SP_DEVINFO_DATA,
        driver_info_data: *const c_void,
        flags: u32,
        need_reboot: *mut i32,
    ) -> i32;

    fn DiUninstallDevice(
        hwnd_parent: *mut c_void,
        device_info_set: isize,
        device_info_data: *mut SP_DEVINFO_DATA,
        flags: u32,
        need_reboot: *mut i32,
    ) -> i32;
}

#[repr(C)]
struct ShellExecuteInfoW {
    cb_size: u32,
    f_mask: u32,
    hwnd: *mut c_void,
    lp_verb: *const u16,
    lp_file: *const u16,
    lp_parameters: *const u16,
    lp_directory: *const u16,
    n_show: i32,
    h_inst_app: *mut c_void,
    lp_id_list: *mut c_void,
    lp_class: *const u16,
    hkey_class: *mut c_void,
    dw_hot_key: u32,
    h_icon_or_monitor: *mut c_void,
    h_process: HANDLE,
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteExW(p_exec_info: *mut ShellExecuteInfoW) -> i32;
}

struct DeviceSet(HDEVINFO);
impl Drop for DeviceSet {
    fn drop(&mut self) {
        unsafe {
            let _ = SetupDiDestroyDeviceInfoList(self.0);
        }
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdminWorkerReply {
    version: u32,
    action: String,
    ok: bool,
    exit_code: i32,
    reboot_required: bool,
    already_existed: bool,
    installed: bool,
    message: String,
}

static PROBE_CACHE: Mutex<Option<(Instant, bool, bool)>> = Mutex::new(None);

pub fn invalidate_probe_cache() {
    if let Ok(mut guard) = PROBE_CACHE.lock() {
        *guard = None;
    }
}

fn normalize_win32_path(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn to_multi_sz_bytes(id: &str) -> Vec<u8> {
    let mut wide: Vec<u16> = id.encode_utf16().collect();
    wide.push(0);
    wide.push(0);
    let mut bytes = Vec::with_capacity(wide.len() * 2);
    for unit in wide {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn is_devnode_present(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> bool {
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
    .is_ok()
        && value[0] != 0
}

fn has_bound_driver(set: &DeviceSet, info: &SP_DEVINFO_DATA) -> bool {
    let mut size = 0u32;
    match unsafe {
        SetupDiGetDeviceRegistryPropertyW(set.0, info, SPDRP_DRIVER, None, None, Some(&mut size))
    } {
        Err(e) if e.code() == ERROR_INVALID_DATA.to_hresult() => return false,
        Err(e) if e.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() => return false,
        _ => {}
    }
    size > 2
}

/// Checks whether `ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE` exists in PnP
/// at all (including offline, unbound, or partially configured states) so uninstallation
/// and global driver cleanup never leave an unassociated output node behind.
pub fn probe_standalone_vhid_exists() -> Result<bool, String> {
    let set = DeviceSet(
        unsafe { SetupDiCreateDeviceInfoList(Some(&HID_CLASS), None) }
            .map_err(|e| format!("无法创建设备信息集：{e}"))?,
    );
    let id_w = to_wide_null(MOBILE_VHID_INSTANCE_ID);
    let mut info = SP_DEVINFO_DATA {
        cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
        ..Default::default()
    };
    let opened =
        unsafe { SetupDiOpenDeviceInfoW(set.0 .0, id_w.as_ptr(), null_mut(), 0, &mut info) != 0 };
    if !opened {
        let err = unsafe { GetLastError() };
        if err == ERROR_NO_SUCH_DEVINST {
            return Ok(false);
        }
        return Ok(false);
    }
    Ok(true)
}

/// Checks whether the standalone `ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE`
/// devnode specifically exists, is online, and has a bound driver.
pub fn probe_standalone_vhid_installed() -> Result<bool, String> {
    let set = DeviceSet(
        unsafe { SetupDiCreateDeviceInfoList(Some(&HID_CLASS), None) }
            .map_err(|e| format!("无法创建设备信息集：{e}"))?,
    );
    let id_w = to_wide_null(MOBILE_VHID_INSTANCE_ID);
    let mut info = SP_DEVINFO_DATA {
        cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
        ..Default::default()
    };
    let opened =
        unsafe { SetupDiOpenDeviceInfoW(set.0 .0, id_w.as_ptr(), null_mut(), 0, &mut info) != 0 };
    if !opened {
        let err = unsafe { GetLastError() };
        if err == ERROR_NO_SUCH_DEVINST {
            return Ok(false);
        }
        return Ok(false);
    }
    Ok(is_devnode_present(&set, &info) && has_bound_driver(&set, &info))
}

fn probe_quarbor_flags() -> (bool, bool) {
    let standalone = probe_standalone_vhid_installed().unwrap_or(false);
    if standalone {
        return (true, true);
    }
    let any_bound = crate::windows_driver_devices::list_present()
        .map(|devices| devices.into_iter().any(|d| d.present && d.bound))
        .unwrap_or(false);
    (any_bound, false)
}

/// Returns `(driver_installed, driver_connected, standalone_vhid_installed)` for `axonkeyMobile`:
/// - Immediately reports `installed = true, connected = true` when an in-process
///   `ManagedQuarborChannel` (e.g. Xiaomi RC003) or direct Quarbor pipe is connected.
/// - Otherwise checks (with a 1.5s cache) whether EITHER `AXONKEYMOBILE` OR any online
///   Quarbor-bound device exists in Windows PnP, enabling direct pipe connection if needed.
pub fn driver_availability(any_mobile_enabled: bool) -> (bool, bool, bool) {
    const TTL: Duration = Duration::from_millis(1500);
    let cached_pair = if let Ok(guard) = PROBE_CACHE.lock() {
        guard.and_then(|(at, installed, standalone)| {
            (at.elapsed() < TTL).then_some((installed, standalone))
        })
    } else {
        None
    };
    let (probed_installed, standalone_installed) = cached_pair.unwrap_or_else(|| {
        let (inst, standalone) = probe_quarbor_flags();
        if let Ok(mut guard) = PROBE_CACHE.lock() {
            *guard = Some((Instant::now(), inst, standalone));
        }
        (inst, standalone)
    });

    if crate::input_service::mobile_quarbor::is_connected() {
        return (true, true, standalone_installed);
    }
    crate::input_service::mobile_quarbor::set_connect_enabled(
        probed_installed && any_mobile_enabled,
    );
    let connected = probed_installed && crate::input_service::mobile_quarbor::is_connected();
    (probed_installed, connected, standalone_installed)
}

pub fn find_driver_inf(resource_dir: &Path) -> Result<PathBuf, String> {
    let installer = normalize_win32_path(crate::quarbor_installer::find(resource_dir)?);
    let dir = installer
        .parent()
        .ok_or_else(|| "无法解析 Quarbor 驱动目录。".to_string())?;
    for candidate in [
        dir.join("QuarborUniversalKeyboardDriver")
            .join(DRIVER_INF_NAME),
        dir.join(DRIVER_INF_NAME),
    ] {
        if candidate.is_file() {
            return Ok(normalize_win32_path(candidate));
        }
    }
    Err(format!("未找到 Quarbor 签名驱动包：{DRIVER_INF_NAME}"))
}

fn last_win32_error(context: &str) -> String {
    let code = unsafe { GetLastError().0 };
    format!("{context}（Win32 错误码 0x{code:08X} / {code}）")
}

/// Creates the in-memory `SP_DEVINFO_DATA` for `ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE`
/// and populates `SPDRP_HARDWAREID`. Separated so unit tests can verify SetupAPI acceptance
/// directly without Administrator elevation.
fn create_vhid_devinfo_in_set(set: &DeviceSet) -> Result<SP_DEVINFO_DATA, String> {
    // IMPORTANT: Without DICD_GENERATE_ID, SetupDiCreateDeviceInfoW requires the full
    // three-segment Root-enumerated instance ID ("ROOT\\QUARBORUNIVERSALKEYBOARDOUTPUT\\AXONKEYMOBILE");
    // omitting "ROOT\\" fails with ERROR_INVALID_DEVINST_NAME (0xE0000205).
    let full_instance_w = to_wide_null(MOBILE_VHID_INSTANCE_ID);
    let desc_w = to_wide_null(MOBILE_VHID_DESCRIPTION);
    let mut info = SP_DEVINFO_DATA {
        cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
        ..Default::default()
    };
    let created = unsafe {
        SetupDiCreateDeviceInfoW(
            set.0 .0,
            full_instance_w.as_ptr(),
            &HID_CLASS,
            desc_w.as_ptr(),
            null_mut(),
            DICD_INHERIT_CLASSDRVS,
            &mut info,
        ) != 0
    };
    if !created {
        return Err(last_win32_error("创建虚拟 HID 设备节点失败"));
    }

    let hwid_multi = to_multi_sz_bytes(MOBILE_VHID_HARDWARE_ID);
    let prop_ok = unsafe {
        SetupDiSetDeviceRegistryPropertyW(
            set.0 .0,
            &mut info,
            SPDRP_HARDWAREID_RAW,
            hwid_multi.as_ptr(),
            hwid_multi.len() as u32,
        ) != 0
    };
    if !prop_ok {
        return Err(last_win32_error("写入虚拟 HID 硬件 ID 失败"));
    }
    Ok(info)
}

fn execute_elevated_install(inf_path: &Path) -> Result<(bool, bool), String> {
    let clean_inf = normalize_win32_path(inf_path.to_path_buf());
    if !clean_inf.is_file() {
        return Err(format!("驱动 INF 文件不存在：{}", clean_inf.display()));
    }
    let inf_dir = clean_inf
        .parent()
        .ok_or_else(|| "无效的 INF 父目录".to_string())?;

    // 1. Stage signed QuarborUniversalKeyboardDriver.inf into Windows DriverStore without touching existing devices.
    let inf_w = to_wide_null(&clean_inf.to_string_lossy());
    let inf_dir_w = to_wide_null(&inf_dir.to_string_lossy());
    let staged = unsafe {
        SetupCopyOEMInfW(
            inf_w.as_ptr(),
            inf_dir_w.as_ptr(),
            SPOST_PATH,
            0,
            null_mut(),
            0,
            null_mut(),
            null_mut(),
        ) != 0
    };
    if !staged {
        return Err(last_win32_error(
            "导入签名驱动包到 Windows DriverStore 失败",
        ));
    }

    // 2. Open or create ROOT\QUARBORUNIVERSALKEYBOARDOUTPUT\AXONKEYMOBILE under HIDClass.
    let set = DeviceSet(
        unsafe { SetupDiCreateDeviceInfoList(Some(&HID_CLASS), None) }
            .map_err(|e| format!("无法初始化 HIDClass 设备列表：{e}"))?,
    );
    let full_id_w = to_wide_null(MOBILE_VHID_INSTANCE_ID);
    let mut info = SP_DEVINFO_DATA {
        cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
        ..Default::default()
    };

    let mut already_existed = false;
    let opened = unsafe {
        SetupDiOpenDeviceInfoW(set.0 .0, full_id_w.as_ptr(), null_mut(), 0, &mut info) != 0
    };
    if opened {
        if is_devnode_present(&set, &info) {
            already_existed = true;
            let hwid_multi = to_multi_sz_bytes(MOBILE_VHID_HARDWARE_ID);
            let _ = unsafe {
                SetupDiSetDeviceRegistryPropertyW(
                    set.0 .0,
                    &mut info,
                    SPDRP_HARDWAREID_RAW,
                    hwid_multi.as_ptr(),
                    hwid_multi.len() as u32,
                )
            };
        } else {
            let mut dummy_reboot = 0i32;
            let _ =
                unsafe { DiUninstallDevice(null_mut(), set.0 .0, &mut info, 0, &mut dummy_reboot) };
        }
    }

    if !already_existed {
        info = create_vhid_devinfo_in_set(&set)?;
        let registered =
            unsafe { SetupDiCallClassInstaller(DIF_REGISTERDEVICE_RAW, set.0 .0, &mut info) != 0 };
        if !registered {
            return Err(last_win32_error("向 PnP 注册虚拟 HID 设备节点失败"));
        }
    }

    // 3. Bind DriverStore driver ONLY to this specific devnode (leaves physical remotes untouched).
    let mut need_reboot = 0i32;
    let installed =
        unsafe { DiInstallDevice(null_mut(), set.0 .0, &info, null(), 0, &mut need_reboot) != 0 };
    if !installed {
        return Err(last_win32_error("绑定 Quarbor 虚拟 HID 输出驱动失败"));
    }

    Ok((already_existed, need_reboot != 0))
}

fn execute_elevated_uninstall() -> Result<bool, String> {
    let set = DeviceSet(
        unsafe { SetupDiCreateDeviceInfoList(Some(&HID_CLASS), None) }
            .map_err(|e| format!("无法初始化 HIDClass 设备列表：{e}"))?,
    );
    let full_id_w = to_wide_null(MOBILE_VHID_INSTANCE_ID);
    let mut info = SP_DEVINFO_DATA {
        cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
        ..Default::default()
    };
    let opened = unsafe {
        SetupDiOpenDeviceInfoW(set.0 .0, full_id_w.as_ptr(), null_mut(), 0, &mut info) != 0
    };
    if !opened {
        return Ok(false);
    }
    let mut need_reboot = 0i32;
    let removed =
        unsafe { DiUninstallDevice(null_mut(), set.0 .0, &mut info, 0, &mut need_reboot) != 0 };
    if !removed {
        return Err(last_win32_error("卸载虚拟 HID 设备节点失败"));
    }
    Ok(need_reboot != 0)
}

/// Checks if the current process was launched as an uninstaller/elevated helper:
/// 1. `--uninstall-mobile-vhid-if-present` (called by NSIS `uninstall.exe` before `--uninstall-all`):
///    exits `0` immediately without UAC if `AXONKEYMOBILE` does not exist; otherwise removes it
///    (self-elevating via UAC if needed) so `QuarborUniversalKeyboardDriverInstaller.exe --uninstall-all`
///    can purge all bindings and Driver Store packages cleanly.
/// 2. `--axonkey-mobile-vhid-admin <install|uninstall> --inf <path> --output <path>`:
///    executes the elevated SetupAPI / newdev action directly.
pub fn maybe_run_from_cli_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == UNINSTALL_IF_PRESENT_CLI_FLAG) {
        if !probe_standalone_vhid_exists().unwrap_or(false) {
            return Some(0);
        }
        if let Ok(reboot) = execute_elevated_uninstall() {
            return Some(if reboot { 3010 } else { 0 });
        }
        let log_path = std::env::temp_dir().join("axonkey-nsis-mobile-vhid-uninstall.log");
        let empty_res = PathBuf::new();
        return Some(match run_admin_action("uninstall", &empty_res, &log_path) {
            Ok(res) if res.reboot_required => 3010,
            Ok(_) => 0,
            Err(_) => 1,
        });
    }
    let flag_pos = args.iter().position(|a| a == ADMIN_CLI_FLAG)?;
    let action = args.get(flag_pos + 1).cloned().unwrap_or_default();
    let mut inf_path: Option<PathBuf> = None;
    let mut output_path: Option<PathBuf> = None;

    let mut idx = flag_pos + 2;
    while idx < args.len() {
        match args[idx].as_str() {
            "--inf" => {
                if let Some(val) = args.get(idx + 1) {
                    inf_path = Some(PathBuf::from(val));
                }
                idx += 2;
            }
            "--output" => {
                if let Some(val) = args.get(idx + 1) {
                    output_path = Some(PathBuf::from(val));
                }
                idx += 2;
            }
            _ => idx += 1,
        }
    }

    let reply = match action.as_str() {
        "install" => match inf_path {
            Some(ref inf) => match execute_elevated_install(inf) {
                Ok((already_existed, reboot_required)) => AdminWorkerReply {
                    version: 1,
                    action,
                    ok: true,
                    exit_code: if reboot_required { 3010 } else { 0 },
                    reboot_required,
                    already_existed,
                    installed: probe_standalone_vhid_installed().unwrap_or(true),
                    message: "Axonkey Mobile 虚拟 HID 驱动安装成功。".into(),
                },
                Err(err) => AdminWorkerReply {
                    version: 1,
                    action,
                    ok: false,
                    exit_code: 1,
                    reboot_required: false,
                    already_existed: false,
                    installed: probe_standalone_vhid_installed().unwrap_or(false),
                    message: err,
                },
            },
            None => AdminWorkerReply {
                version: 1,
                action,
                ok: false,
                exit_code: 2,
                reboot_required: false,
                already_existed: false,
                installed: false,
                message: "缺少 --inf 参数".into(),
            },
        },
        "uninstall" => match execute_elevated_uninstall() {
            Ok(reboot_required) => AdminWorkerReply {
                version: 1,
                action,
                ok: true,
                exit_code: if reboot_required { 3010 } else { 0 },
                reboot_required,
                already_existed: false,
                installed: false,
                message: "Axonkey Mobile 虚拟 HID 驱动已移除。".into(),
            },
            Err(err) => AdminWorkerReply {
                version: 1,
                action,
                ok: false,
                exit_code: 1,
                reboot_required: false,
                already_existed: false,
                installed: probe_standalone_vhid_installed().unwrap_or(false),
                message: err,
            },
        },
        _ => AdminWorkerReply {
            version: 1,
            action,
            ok: false,
            exit_code: 2,
            reboot_required: false,
            already_existed: false,
            installed: false,
            message: "不支持的驱动管理动作".into(),
        },
    };

    let code = reply.exit_code;
    if let Some(out) = output_path {
        if let Ok(json) = serde_json::to_vec_pretty(&reply) {
            let _ = std::fs::write(out, json);
        }
    }
    Some(code)
}

fn quote_windows_arg(arg: &str) -> String {
    let escaped = arg.replace('"', "\\\"");
    format!("\"{escaped}\"")
}

pub(crate) fn run_admin_action(
    action: &str,
    resource_dir: &Path,
    log_path: &Path,
) -> Result<crate::DriverActionResult, String> {
    if !matches!(action, "install" | "uninstall") {
        return Err("不支持的虚拟 HID 驱动操作。".into());
    }
    let current_exe = normalize_win32_path(
        std::env::current_exe().map_err(|e| format!("无法定位当前程序路径：{e}"))?,
    );
    let inf_path = if action == "install" {
        Some(find_driver_inf(resource_dir)?)
    } else {
        find_driver_inf(resource_dir).ok()
    };

    let output_path = std::env::temp_dir().join(format!(
        "axonkey-mobile-vhid-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("无法生成临时结果文件：{e}"))?
            .as_nanos()
    ));

    let mut params = format!("{ADMIN_CLI_FLAG} {action}");
    if let Some(ref inf) = inf_path {
        params.push_str(" --inf ");
        params.push_str(&quote_windows_arg(&inf.to_string_lossy()));
    }
    params.push_str(" --output ");
    params.push_str(&quote_windows_arg(&output_path.to_string_lossy()));

    crate::input_service::mobile_quarbor::pause();

    let launch_result = (|| -> Result<AdminWorkerReply, String> {
        let exe_w = to_wide_null(&current_exe.to_string_lossy());
        let params_w = to_wide_null(&params);
        let mut sei = ShellExecuteInfoW {
            cb_size: size_of::<ShellExecuteInfoW>() as u32,
            f_mask: SEE_MASK_NOCLOSEPROCESS,
            hwnd: null_mut(),
            lp_verb: w!("runas").as_ptr(),
            lp_file: exe_w.as_ptr(),
            lp_parameters: params_w.as_ptr(),
            lp_directory: null(),
            n_show: SW_HIDE,
            h_inst_app: null_mut(),
            lp_id_list: null_mut(),
            lp_class: null(),
            hkey_class: null_mut(),
            dw_hot_key: 0,
            h_icon_or_monitor: null_mut(),
            h_process: HANDLE::default(),
        };

        let launched = unsafe { ShellExecuteExW(&mut sei) != 0 };
        if !launched {
            let err = unsafe { GetLastError() };
            if err == ERROR_CANCELLED {
                return Err("已取消管理员授权，驱动操作未完成，请重新尝试。".into());
            }
            return Err(format!("无法启动管理员授权进程（错误码 {}）", err.0));
        }

        let mut exit_code = 1u32;
        if !sei.h_process.is_invalid() {
            let wait = unsafe { WaitForSingleObject(sei.h_process, 120_000) };
            let _ = unsafe { GetExitCodeProcess(sei.h_process, &mut exit_code) };
            let _ = unsafe { CloseHandle(sei.h_process) };
            if wait != WAIT_OBJECT_0 {
                return Err("等待驱动安装进程完成超时，请重试。".into());
            }
        }

        let raw = std::fs::read(&output_path).unwrap_or_default();
        let _ = std::fs::remove_file(&output_path);

        let log_body = format!(
            "Axonkey Mobile Virtual HID ({action})\r\nExecutable: {}\r\nINF: {:?}\r\nExitCode: {exit_code}\r\nOutput:\r\n{}\r\n",
            current_exe.display(),
            inf_path,
            String::from_utf8_lossy(&raw)
        );
        let _ = std::fs::write(log_path, log_body);

        if raw.is_empty() {
            return Err(format!(
                "未读取到驱动操作结果（退出码 {exit_code}），日志：{}",
                log_path.display()
            ));
        }
        let reply: AdminWorkerReply =
            serde_json::from_slice(&raw).map_err(|e| format!("解析驱动操作结果失败：{e}"))?;
        if !reply.ok {
            return Err(format!("{}（日志：{}）", reply.message, log_path.display()));
        }
        Ok(reply)
    })();

    invalidate_probe_cache();
    crate::input_service::mobile_quarbor::resume();
    if action == "install" && launch_result.is_ok() {
        crate::input_service::mobile_quarbor::set_connect_enabled(true);
    }

    let reply = launch_result?;
    let installation_state = if action == "install" {
        Some(if reply.already_existed {
            crate::DriverInstallationState::Reinstalled
        } else {
            crate::DriverInstallationState::Installed
        })
    } else {
        None
    };

    Ok(crate::DriverActionResult {
        log_path: log_path.to_string_lossy().into_owned(),
        reboot_required: reply.reboot_required,
        installation_state,
        driver_installed: Some(reply.installed),
        warning: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_double_null_terminated_hardware_id_multi_sz_and_strips_verbatim_prefix() {
        let bytes = to_multi_sz_bytes("ABC");
        assert_eq!(bytes, vec![b'A', 0, b'B', 0, b'C', 0, 0, 0, 0, 0]);
        assert_eq!(
            normalize_win32_path(PathBuf::from(r"\\?\D:\workspace\axonkey\driver.inf")),
            PathBuf::from(r"D:\workspace\axonkey\driver.inf")
        );
    }

    #[test]
    fn locates_bundled_signed_quarbor_inf_without_verbatim_prefix() {
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let inf = find_driver_inf(&resources).expect("QuarborUniversalKeyboardDriver.inf");
        assert!(inf.is_file());
        assert!(!inf.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn setupdi_validates_root_enumerated_instance_id_syntax() {
        // SetupDiCreateDeviceInfoW validates DeviceName syntax BEFORE touching HKLM\...\Enum\ROOT:
        // - A 2-segment name without "ROOT\\" fails immediately with 0xE0000205 (ERROR_INVALID_DEVINST_NAME).
        // - Full "ROOT\\QUARBORUNIVERSALKEYBOARDOUTPUT\\AXONKEYMOBILE" passes syntax validation
        //   (returning Ok(_) when elevated, or 0x00000005 ERROR_ACCESS_DENIED when non-elevated).
        let set = DeviceSet(
            unsafe { SetupDiCreateDeviceInfoList(Some(&HID_CLASS), None) }
                .expect("SetupDiCreateDeviceInfoList"),
        );
        match create_vhid_devinfo_in_set(&set) {
            Ok(mut info) => {
                assert_eq!(info.ClassGuid, HID_CLASS);
                let mut reboot = 0i32;
                unsafe {
                    let _ = DiUninstallDevice(null_mut(), set.0 .0, &mut info, 0, &mut reboot);
                }
            }
            Err(err) => {
                assert!(
                    !err.contains("0xE0000205"),
                    "Instance ID syntax must never fail with ERROR_INVALID_DEVINST_NAME: {err}"
                );
                assert!(
                    err.contains("0x00000005"),
                    "Expected only non-elevated ERROR_ACCESS_DENIED (5), got: {err}"
                );
            }
        }
    }
}
