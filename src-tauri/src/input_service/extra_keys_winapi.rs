// SPDX-License-Identifier: GPL-3.0-only
//! Narrow Windows operations for the optional elevated HID helper.
use std::os::windows::ffi::OsStrExt;
use std::{
    ffi::c_void,
    net::TcpStream,
    path::{Path, PathBuf},
    ptr::null_mut,
};
use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

type Handle = *mut c_void;
pub struct OwnedHandle(pub Handle);
unsafe impl Send for OwnedHandle {}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn last_error() -> String {
    std::io::Error::last_os_error().to_string()
}

#[repr(C)]
struct ShellExecuteInfo {
    size: u32,
    mask: u32,
    hwnd: Handle,
    verb: *const u16,
    file: *const u16,
    parameters: *const u16,
    directory: *const u16,
    show: i32,
    instance: Handle,
    id_list: Handle,
    class: *const u16,
    class_key: Handle,
    hot_key: u32,
    icon: Handle,
    process: Handle,
}
pub fn elevate(parameters: &str) -> Result<OwnedHandle, String> {
    // Shell extensions may require COM; this runs on our fresh worker thread.
    let com = unsafe { CoInitializeEx(null_mut(), 2 | 4) };
    if com < 0 {
        return Err(format!("无法初始化系统授权：0x{:08X}", com as u32));
    }
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let _com = ComGuard;
    let exe = wide(std::env::current_exe().map_err(|e| e.to_string())?);
    let verb = wide("runas");
    let parameters = wide(parameters);
    let mut info: ShellExecuteInfo = unsafe { std::mem::zeroed() };
    info.size = std::mem::size_of::<ShellExecuteInfo>() as u32;
    info.mask = 0x40 | 0x100 | 0x400; // process handle, synchronous shell launch, no error UI
    info.verb = verb.as_ptr();
    info.file = exe.as_ptr();
    info.parameters = parameters.as_ptr();
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        if std::io::Error::last_os_error().raw_os_error() == Some(1223) {
            return Err("已取消管理员授权。这三个按键尚未启用，可点击重新授权。".into());
        }
        return Err(format!("无法请求管理员权限：{}", last_error()));
    }
    if info.process.is_null() {
        return Err("管理员辅助进程未启动".into());
    }
    Ok(OwnedHandle(info.process))
}
pub fn process_id(handle: &OwnedHandle) -> u32 {
    unsafe { GetProcessId(handle.0) }
}
pub fn alive(handle: &OwnedHandle) -> bool {
    unsafe { WaitForSingleObject(handle.0, 0) == 258 }
}
pub fn elevated() -> bool {
    unsafe { IsUserAnAdmin() != 0 }
}

pub fn peer_pid(stream: &TcpStream) -> Option<u32> {
    let peer = stream.peer_addr().ok()?;
    let local = stream.local_addr().ok()?;
    if !peer.ip().is_loopback() || !local.ip().is_loopback() {
        return None;
    }
    let mut size = 0u32;
    unsafe {
        GetExtendedTcpTable(null_mut(), &mut size, 0, 2, 5, 0);
    }
    if !(4..=16_777_216).contains(&size) {
        return None;
    }
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    if unsafe { GetExtendedTcpTable(buffer.as_mut_ptr().cast(), &mut size, 0, 2, 5, 0) } != 0 {
        return None;
    }
    let count = buffer[0] as usize;
    if 1 + count * 6 > buffer.len() {
        return None;
    }
    buffer[1..1 + count * 6]
        .chunks_exact(6)
        .find(|r| {
            u16::from_be(r[2] as u16) == peer.port() && u16::from_be(r[4] as u16) == local.port()
        })
        .map(|r| r[5])
}

pub fn random_token() -> Result<String, String> {
    let mut data = [0u8; 32];
    if unsafe { BCryptGenRandom(null_mut(), data.as_mut_ptr(), 32, 2) } != 0 {
        return Err("无法创建安全会话".into());
    }
    Ok(data.iter().map(|b| format!("{b:02x}")).collect())
}

const PREFIX: &str = "{00001812-0000-1000-8000-00805f9b34fb}";
fn rc003(s: &str) -> bool {
    s.contains("dev_vid&012717_pid&32b8_")
}
pub fn target() -> Result<Option<(u32, String)>, String> {
    let root = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SYSTEM\\CurrentControlSet\\Enum\\BTHLEDevice")
        .map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    for service in root.enum_keys().flatten() {
        let lower = service.to_ascii_lowercase();
        if !lower.starts_with(PREFIX) || !rc003(&lower) {
            continue;
        }
        let Ok(key) = root.open_subkey(&service) else {
            continue;
        };
        for instance in key.enum_keys().flatten() {
            let identity = format!("BTHLEDevice\\{service}\\{instance}");
            let mut id = wide(&identity);
            let mut node = 0;
            if unsafe { CM_Locate_DevNodeW(&mut node, id.as_mut_ptr(), 0) } != 0 {
                continue;
            }
            let Ok(diag) =
                key.open_subkey(format!("{instance}\\Device Parameters\\WUDFDiagnosticInfo"))
            else {
                continue;
            };
            // Windows stores HostPid as REG_QWORD on some systems, even though
            // process IDs themselves are 32-bit. Accept both registry forms.
            let host_pid = diag
                .get_value::<u64, _>("HostPid")
                .or_else(|_| diag.get_value::<u32, _>("HostPid").map(u64::from))
                .map_err(|e| format!("无法读取 RC003 驱动进程：{e}"))?;
            if let Ok(pid) = u32::try_from(host_pid) {
                if pid > 0 {
                    found.push((pid, identity));
                }
            }
        }
    }
    if found.len() > 1 {
        return Err("检测到多个 RC003，请只连接一只遥控器后重试。".into());
    }
    Ok(found.pop())
}
pub fn device_names() -> Result<Vec<String>, String> {
    let mut buffer = vec![0u16; 262144];
    let count =
        unsafe { QueryDosDeviceW(std::ptr::null(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if count == 0 {
        return Err(last_error());
    }
    let mut names = Vec::new();
    for entry in buffer[..count as usize].split(|c| *c == 0) {
        let name = String::from_utf16_lossy(entry).to_ascii_lowercase();
        if !name.starts_with(&format!("bthledevice#{PREFIX}")) || !rc003(&name) {
            continue;
        }
        let name = wide(name);
        let mut result = [0u16; 4096];
        if unsafe { QueryDosDeviceW(name.as_ptr(), result.as_mut_ptr(), 4096) } == 0 {
            continue;
        }
        names.push(
            String::from_utf16_lossy(
                &result[..result.iter().position(|c| *c == 0).unwrap_or(4096)],
            )
            .to_ascii_lowercase(),
        );
    }
    names.sort();
    names.dedup();
    if names.len() != 1 {
        return Err("等待唯一的 RC003 输入设备，请唤醒或重新连接遥控器。".into());
    }
    Ok(names)
}

#[repr(C)]
struct Privileges {
    count: u32,
    low: u32,
    high: i32,
    attributes: u32,
}
pub fn debug_privilege() -> Result<(), String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 0x28, &mut token) } == 0 {
        return Err(last_error());
    }
    let _token = OwnedHandle(token);
    let mut p = Privileges {
        count: 1,
        low: 0,
        high: 0,
        attributes: 2,
    };
    let name = wide("SeDebugPrivilege");
    if unsafe { LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut p.low) } == 0 {
        return Err(last_error());
    }
    unsafe {
        SetLastError(0);
    }
    if unsafe { AdjustTokenPrivileges(token, 0, &p, 0, null_mut(), null_mut()) } == 0
        || std::io::Error::last_os_error().raw_os_error() != Some(0)
    {
        return Err(last_error());
    }
    Ok(())
}
pub fn inject(pid: u32, dll: &Path) -> Result<(), String> {
    if target()?.map(|t| t.0) != Some(pid) {
        return Err("RC003 输入宿主已变化，请重试。".into());
    }
    let process = OwnedHandle(unsafe { OpenProcess(0x43a, 0, pid) });
    if process.0.is_null() {
        return Err(last_error());
    }
    let mut image = [0u16; 32768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut length) } == 0 {
        return Err(last_error());
    }
    let image = PathBuf::from(String::from_utf16_lossy(&image[..length as usize]));
    let mut system = [0u16; 32768];
    let len = unsafe { GetSystemDirectoryW(system.as_mut_ptr(), system.len() as u32) } as usize;
    if len == 0 || len >= system.len() {
        return Err(last_error());
    }
    let expected = PathBuf::from(String::from_utf16_lossy(&system[..len])).join("WUDFHost.exe");
    let alternate = expected.parent().unwrap().join("WUDF\\WUDFHost.exe");
    if !image
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.to_string_lossy())
        && !image
            .to_string_lossy()
            .eq_ignore_ascii_case(&alternate.to_string_lossy())
    {
        return Err("输入宿主身份验证失败".into());
    }
    let path = wide(dll);
    let bytes = path.len() * 2;
    let remote = unsafe { VirtualAllocEx(process.0, null_mut(), bytes, 0x3000, 4) };
    if remote.is_null() {
        return Err(last_error());
    }
    let mut written = 0usize;
    let mut may_be_running = false;
    let result = (|| {
        if unsafe {
            WriteProcessMemory(process.0, remote, path.as_ptr().cast(), bytes, &mut written)
        } == 0
            || written != bytes
        {
            return Err(last_error());
        }
        let module = unsafe { GetModuleHandleW(wide("kernel32.dll").as_ptr()) };
        let start = unsafe { GetProcAddress(module, c"LoadLibraryW".as_ptr().cast()) };
        if start.is_null() {
            return Err(last_error());
        }
        let thread = OwnedHandle(unsafe {
            CreateRemoteThread(process.0, null_mut(), 0, start, remote, 0, null_mut())
        });
        if thread.0.is_null() {
            return Err(last_error());
        }
        may_be_running = true;
        if unsafe { WaitForSingleObject(thread.0, 20000) } != 0 {
            return Err("按键组件加载超时，请关闭后重试。".into());
        }
        may_be_running = false;
        let mut code = 0;
        if unsafe { GetExitCodeThread(thread.0, &mut code) } == 0 || code == 0 {
            return Err("Windows 未能加载按键组件。".into());
        }
        Ok(())
    })();
    if !may_be_running {
        unsafe {
            VirtualFreeEx(process.0, remote, 0, 0x8000);
        }
    }
    result
}

pub fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    if std::fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_attributes()
        & 0x400
        != 0
    {
        return Err("按键组件目录不能是链接，请检查安装。".into());
    }
    set_acl(
        path,
        "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)",
    )
}

/// The persistent reconnect credential must not be readable by ordinary users.
/// WUDFHost runs as LocalService and needs read access to the Gadget config.
pub fn secure_control_file(path: &Path) -> Result<(), String> {
    set_acl(path, "O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;LS)")
}
pub fn validate_control_file(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    if std::fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_attributes()
        & 0x400
        != 0
    {
        return Err("按键会话文件不能是链接。".into());
    }
    let name = wide(path);
    let mut size = 0;
    unsafe {
        GetFileSecurityW(name.as_ptr(), 5, null_mut(), 0, &mut size);
    }
    if size == 0 || size > 65536 {
        return Err("无法验证按键会话文件权限。".into());
    }
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    if unsafe {
        GetFileSecurityW(
            name.as_ptr(),
            5,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(last_error());
    }
    let mut owner = null_mut();
    let mut defaulted = 0;
    let mut control = 0u16;
    let mut revision = 0;
    let sd = buffer.as_mut_ptr().cast();
    if unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0
        || control & 0x1000 == 0
    {
        return Err("按键会话文件权限无效，请检查安装。".into());
    }
    let mut text: *mut u16 = null_mut();
    if unsafe { ConvertSidToStringSidW(owner, &mut text) } == 0 {
        return Err(last_error());
    }
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    let sid = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text, length)) };
    unsafe {
        LocalFree(text.cast());
    }
    if sid != "S-1-5-32-544" && sid != "S-1-5-18" {
        return Err("按键会话文件不是由管理员创建的，请检查安装。".into());
    }
    Ok(())
}
fn set_acl(path: &Path, descriptor_text: &str) -> Result<(), String> {
    let mut descriptor = null_mut();
    let sddl = wide(descriptor_text);
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error());
    }
    let ok = unsafe { SetFileSecurityW(wide(path).as_ptr(), 0x80000005, descriptor) };
    unsafe {
        LocalFree(descriptor);
    }
    if ok == 0 {
        return Err(last_error());
    }
    Ok(())
}

#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(h: Handle) -> i32;
    fn GetProcessId(h: Handle) -> u32;
    fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn GetCurrentProcess() -> Handle;
    fn SetLastError(error: u32);
    fn QueryFullProcessImageNameW(h: Handle, flags: u32, name: *mut u16, length: *mut u32) -> i32;
    fn GetSystemDirectoryW(buffer: *mut u16, length: u32) -> u32;
    fn QueryDosDeviceW(name: *const u16, target: *mut u16, size: u32) -> u32;
    fn VirtualAllocEx(h: Handle, address: Handle, size: usize, kind: u32, protect: u32) -> Handle;
    fn VirtualFreeEx(h: Handle, address: Handle, size: usize, kind: u32) -> i32;
    fn WriteProcessMemory(
        h: Handle,
        address: Handle,
        buffer: *const c_void,
        size: usize,
        written: *mut usize,
    ) -> i32;
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetProcAddress(module: Handle, name: *const u8) -> Handle;
    fn CreateRemoteThread(
        h: Handle,
        attributes: Handle,
        stack: usize,
        start: Handle,
        argument: Handle,
        flags: u32,
        id: *mut u32,
    ) -> Handle;
    fn GetExitCodeThread(h: Handle, code: *mut u32) -> i32;
    fn LocalFree(h: Handle) -> Handle;
}
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
    fn IsUserAnAdmin() -> i32;
}
#[link(name = "iphlpapi")]
extern "system" {
    fn GetExtendedTcpTable(
        table: Handle,
        size: *mut u32,
        order: i32,
        family: u32,
        class: u32,
        reserved: u32,
    ) -> u32;
}
#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(algorithm: Handle, bytes: *mut u8, size: u32, flags: u32) -> i32;
}
#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(reserved: Handle, coinit: u32) -> i32;
    fn CoUninitialize();
}
#[link(name = "cfgmgr32")]
extern "system" {
    fn CM_Locate_DevNodeW(node: *mut u32, id: *mut u16, flags: u32) -> u32;
}
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(h: Handle, access: u32, token: *mut Handle) -> i32;
    fn LookupPrivilegeValueW(system: *const u16, name: *const u16, luid: *mut u32) -> i32;
    fn AdjustTokenPrivileges(
        token: Handle,
        disable: i32,
        state: *const Privileges,
        len: u32,
        previous: Handle,
        returned: Handle,
    ) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl: *const u16,
        revision: u32,
        sd: *mut Handle,
        size: *mut u32,
    ) -> i32;
    fn SetFileSecurityW(path: *const u16, information: u32, descriptor: Handle) -> i32;
    fn GetFileSecurityW(
        path: *const u16,
        information: u32,
        descriptor: Handle,
        length: u32,
        needed: *mut u32,
    ) -> i32;
    fn GetSecurityDescriptorOwner(
        descriptor: Handle,
        owner: *mut Handle,
        defaulted: *mut i32,
    ) -> i32;
    fn GetSecurityDescriptorControl(
        descriptor: Handle,
        control: *mut u16,
        revision: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: Handle, text: *mut *mut u16) -> i32;
}
