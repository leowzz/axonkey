//! Startup migration from the old UMDF filter. The journal is written before
//! uninstall-all, so retries (including a new app launch) never lose the targets.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    status: String,
    stage: String,
    message: String,
    devices: Vec<String>,
    reboot_required: bool,
    log_path: Option<String>,
}

pub(crate) struct UpgradeState {
    snapshot: Mutex<Snapshot>,
    pub gate: Arc<AtomicBool>,
    pub operation: Mutex<()>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            status: "checking".into(),
            stage: "checking".into(),
            message: "正在检查旧版 Quarbor 驱动…".into(),
            devices: vec![],
            reboot_required: false,
            log_path: None,
        }
    }
}

impl Default for UpgradeState {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(Snapshot::default()),
            gate: Arc::new(AtomicBool::new(true)),
            operation: Mutex::new(()),
        }
    }
}

impl UpgradeState {
    fn begin_check(&self) {
        self.gate.store(true, Ordering::Release);
        *self.snapshot.lock().unwrap() = Snapshot::default();
    }

    pub fn blocks_close(&self) -> bool {
        let snapshot = self.snapshot.lock().unwrap();
        matches!(snapshot.status.as_str(), "pending" | "running")
    }

    fn update(&self, status: &str, stage: &str, message: String) {
        let mut snapshot = self.snapshot.lock().unwrap();
        snapshot.status = status.into();
        snapshot.stage = stage.into();
        snapshot.message = message;
    }
}

#[tauri::command]
pub(crate) fn get_driver_upgrade_state(app: tauri::AppHandle) -> Option<Snapshot> {
    app.try_state::<UpgradeState>()
        .map(|state| state.snapshot.lock().unwrap().clone())
}

/// Recheck on every explicit installation request, including after a dismissed
/// failure or an earlier successful startup check. true hands off to the modal.
#[tauri::command]
pub(crate) async fn check_driver_upgrade_before_install(
    app: tauri::AppHandle,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<UpgradeState>();
            let _operation = state
                .operation
                .try_lock()
                .map_err(|_| "已有驱动操作正在执行，请稍后重试。")?;
            if state.blocks_close() {
                return Ok(true);
            }
            Ok(windows::check_locked(&app))
        })
        .await
        .map_err(|error| format!("驱动检查任务异常：{error}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("仅 Windows 支持驱动升级。".into())
    }
}

#[tauri::command]
pub(crate) fn dismiss_driver_upgrade(app: tauri::AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<UpgradeState>()
        .ok_or("当前平台不支持驱动升级。")?;
    let mut snapshot = state.snapshot.lock().unwrap();
    if snapshot.status != "failed" {
        return Err("驱动升级期间不能关闭窗口。".into());
    }
    snapshot.status = "dismissed".into();
    state.gate.store(false, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_driver_upgrade(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = app.state::<UpgradeState>();
        {
            let mut snapshot = state.snapshot.lock().unwrap();
            // StrictMode, a webview reload, or repeated clicks cannot launch two installers.
            if snapshot.status == "running" {
                return Ok(());
            }
            if !matches!(snapshot.status.as_str(), "pending" | "failed") {
                return Err("当前没有待升级的驱动。".into());
            }
            snapshot.status = "running".into();
            snapshot.message = "正在准备驱动升级…".into();
        }
        let worker_app = app.clone();
        let result =
            tauri::async_runtime::spawn_blocking(move || windows::execute(&worker_app)).await;
        let result = result
            .map_err(|error| format!("驱动升级任务异常：{error}"))
            .and_then(|result| result);
        if let Err(error) = result {
            windows::fail(&app, error);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("仅 Windows 支持驱动升级。".into())
    }
}

#[cfg(windows)]
pub(crate) use windows::initialize;

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::quarbor_installer::{self, Device};
    use ::windows::core::PCWSTR;
    use ::windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_Device_IDW, CM_Get_Parent, CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_PHANTOM, CR_SUCCESS,
    };
    use std::{
        collections::BTreeSet,
        path::{Path, PathBuf},
    };

    const LEGACY: &str = "quarborhidfilteruserdriver";

    #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
    struct Plan {
        version: u32,
        legacy_devices: Vec<Device>,
        targets: Vec<Device>,
        cleanup_done: bool,
        installed: Vec<String>,
        reboot_required: bool,
    }

    fn journal_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("quarbor-driver-upgrade.json"))
    }

    fn load(path: &Path) -> Result<Option<Plan>, String> {
        match std::fs::read(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("无法读取驱动升级记录：{e}")),
            Ok(bytes) => {
                let plan: Plan =
                    serde_json::from_slice(&bytes).map_err(|e| format!("驱动升级记录损坏：{e}"))?;
                if plan.version != 1 {
                    return Err("不支持的驱动升级记录版本。".into());
                }
                Ok(Some(plan))
            }
        }
    }

    fn save(path: &Path, plan: &Plan) -> Result<(), String> {
        use std::io::Write;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        // A replacement file prevents an interrupted write from truncating the only target list.
        let temp = path.with_extension("tmp");
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(temp, path).map_err(|e| format!("无法保存驱动升级记录：{e}"))
    }

    fn inf_text(bytes: &[u8]) -> String {
        if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
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
        }
    }

    fn legacy_packages() -> Result<BTreeSet<String>, String> {
        let root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows INF 目录。")?;
        let mut packages = BTreeSet::new();
        for entry in
            std::fs::read_dir(PathBuf::from(root).join("INF")).map_err(|e| e.to_string())?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.starts_with("oem") || !name.ends_with(".inf") {
                continue;
            }
            let bytes =
                std::fs::read(entry.path()).map_err(|e| format!("无法检查驱动包 {name}：{e}"))?;
            if inf_text(&bytes)
                .to_ascii_lowercase()
                .contains(&format!("{LEGACY}.dll"))
            {
                packages.insert(name);
            }
        }
        Ok(packages)
    }

    fn is_legacy(device: &Device, packages: &BTreeSet<String>) -> bool {
        packages.contains(&device.inf.to_ascii_lowercase())
            || device.section.to_ascii_lowercase().starts_with(LEGACY)
    }

    fn parents(id: &str) -> Result<Vec<String>, String> {
        let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
        let mut node = 0;
        let mut result = vec![];
        unsafe {
            let status =
                CM_Locate_DevNodeW(&mut node, PCWSTR(wide.as_ptr()), CM_LOCATE_DEVNODE_PHANTOM);
            if status != CR_SUCCESS {
                return Err(format!(
                    "无法定位原设备 {id}（{}），请连接设备后重试。",
                    status.0
                ));
            }
            for _ in 0..32 {
                let mut parent = 0;
                if CM_Get_Parent(&mut parent, node, 0) != CR_SUCCESS {
                    break;
                }
                let mut buffer = [0u16; 1024];
                if CM_Get_Device_IDW(parent, &mut buffer, 0) != CR_SUCCESS {
                    return Err(format!("无法读取设备 {id} 的父设备。"));
                }
                let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                result.push(String::from_utf16_lossy(&buffer[..len]));
                node = parent;
            }
        }
        Ok(result)
    }

    fn make_plan(
        devices: &[Device],
        packages: &BTreeSet<String>,
        mut ancestors: impl FnMut(&str) -> Result<Vec<String>, String>,
    ) -> Result<Option<Plan>, String> {
        let legacy_devices: Vec<_> = devices
            .iter()
            .filter(|d| is_legacy(d, packages))
            .cloned()
            .collect();
        if legacy_devices.is_empty() && packages.is_empty() {
            return Ok(None);
        }
        let mut targets: Vec<Device> = vec![];
        for device in &legacy_devices {
            // Old RC003 filters live on a HID child. The duplex backend uses its
            // actual BTHLEDEVICE ancestor, never a VID/PID match to another remote.
            let chain = ancestors(&device.instance_id)?;
            let parent = chain.iter().find_map(|id| {
                devices.iter().find(|d| {
                    d.instance_id.eq_ignore_ascii_case(id)
                        && id.to_ascii_uppercase().starts_with("BTHLEDEVICE\\")
                })
            });
            if device.is_rc003_hardware() && !device.is_rc003() && parent.is_none() {
                return Err(format!(
                    "无法确定 RC003 原设备的蓝牙父设备：{}。请连接并唤醒该遥控器后重试。",
                    device.instance_id
                ));
            }
            targets.push(parent.unwrap_or(device).clone());
        }
        // uninstall-all also removes existing Universal bindings. Restore those too.
        targets.extend(
            devices
                .iter()
                .filter(|d| !is_legacy(d, packages) && (d.bound || d.recovery_active))
                .cloned(),
        );
        targets.sort_by_key(|d| d.instance_id.to_ascii_uppercase());
        targets.dedup_by(|a, b| a.instance_id.eq_ignore_ascii_case(&b.instance_id));
        Ok(Some(Plan {
            version: 1,
            legacy_devices,
            targets,
            cleanup_done: false,
            installed: vec![],
            reboot_required: false,
        }))
    }

    fn prepare(app: &tauri::AppHandle) -> Result<Option<Plan>, String> {
        let path = journal_path(app)?;
        if let Some(plan) = load(&path)? {
            return Ok(Some(plan));
        }
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let devices = quarbor_installer::list(&resources)?;
        let plan = make_plan(&devices, &legacy_packages()?, parents)?;
        if let Some(plan) = &plan {
            save(&path, plan)?;
        }
        Ok(plan)
    }

    fn describe(plan: &Plan) -> Vec<String> {
        plan.targets
            .iter()
            .map(|d| {
                if d.name.is_empty() {
                    d.instance_id.clone()
                } else {
                    format!("{} · {}", d.name, d.instance_id)
                }
            })
            .collect()
    }

    pub(super) fn fail(app: &tauri::AppHandle, error: String) {
        log::error!(target: "axonkey::driver_upgrade", "{error}");
        let state = app.state::<UpgradeState>();
        let mut snapshot = state.snapshot.lock().unwrap();
        snapshot.status = "failed".into();
        snapshot.message = error;
        drop(snapshot);
        crate::show_main_window(app);
    }

    pub(super) fn check_locked(app: &tauri::AppHandle) -> bool {
        let state = app.state::<UpgradeState>();
        state.begin_check();
        match prepare(app) {
            Ok(Some(plan)) => {
                state.snapshot.lock().unwrap().devices = describe(&plan);
                state.update(
                    "pending",
                    "recorded",
                    "已记录原驱动绑定设备，正在准备升级…".into(),
                );
                // Also reveal the modal for an otherwise hidden autostart launch.
                crate::show_main_window(app);
                true
            }
            Ok(None) => {
                state.update("notNeeded", "checking", String::new());
                state.gate.store(false, Ordering::Release);
                false
            }
            Err(error) => {
                fail(app, error);
                true
            }
        }
    }

    pub(crate) fn initialize(app: tauri::AppHandle) {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<UpgradeState>();
            let _operation = state.operation.lock().unwrap();
            check_locked(&app);
        });
    }

    trait Operations {
        fn checkpoint(&mut self, plan: &Plan) -> Result<(), String>;
        fn uninstall_all(&mut self) -> Result<bool, String>;
        fn install(&mut self, device: &Device) -> Result<bool, String>;
    }

    fn advance(plan: &mut Plan, ops: &mut impl Operations) -> Result<(), String> {
        // Required even on retry: no destructive operation without a durable plan.
        ops.checkpoint(plan)?;
        if !plan.cleanup_done {
            plan.reboot_required |= ops.uninstall_all()?;
            plan.cleanup_done = true;
            ops.checkpoint(plan)?;
        }
        for device in plan.targets.clone() {
            if plan.installed.contains(&device.instance_id) {
                continue;
            }
            plan.reboot_required |= ops.install(&device)?;
            plan.installed.push(device.instance_id);
            ops.checkpoint(plan)?;
        }
        Ok(())
    }

    struct Installer<'a> {
        state: &'a UpgradeState,
        exe: PathBuf,
        journal: PathBuf,
        log: PathBuf,
    }
    impl Operations for Installer<'_> {
        fn checkpoint(&mut self, plan: &Plan) -> Result<(), String> {
            self.state.snapshot.lock().unwrap().reboot_required = plan.reboot_required;
            save(&self.journal, plan)
        }
        fn uninstall_all(&mut self) -> Result<bool, String> {
            self.state.update(
                "running",
                "uninstalling",
                "正在卸载全部 Quarbor 驱动，请在系统提示中允许管理员授权…".into(),
            );
            let reply =
                quarbor_installer::invoke(&self.exe, "uninstall-all", None, Some(&self.log))?;
            let reboot = reply.reboot_required || reply.exit_code == 3010;
            if !reboot && !legacy_packages()?.is_empty() {
                return Err("旧驱动包尚未清理完成，请重启 Windows 后再次尝试升级。".into());
            }
            Ok(reboot)
        }
        fn install(&mut self, device: &Device) -> Result<bool, String> {
            self.state.update(
                "running",
                "installing",
                format!("正在为原设备安装新版驱动：{}", device.instance_id),
            );
            let reply = quarbor_installer::invoke(
                &self.exe,
                "install",
                Some(&device.instance_id),
                Some(&self.log),
            )?;
            Ok(reply.reboot_required || reply.exit_code == 3010)
        }
    }

    pub(super) fn execute(app: &tauri::AppHandle) -> Result<(), String> {
        let state = app.state::<UpgradeState>();
        let _operation = state.operation.lock().map_err(|e| e.to_string())?;
        let Some(mut plan) = prepare(app)? else {
            state.update("complete", "complete", "驱动检查已完成。".into());
            state.gate.store(false, Ordering::Release);
            return Ok(());
        };
        state.snapshot.lock().unwrap().devices = describe(&plan);
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let log = crate::driver_log_path("input", "upgrade")?;
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)
                .map_err(|e| e.to_string())?,
            "\nUpgrade attempt: {:?}\n{}",
            std::time::SystemTime::now(),
            serde_json::to_string(&plan).map_err(|e| e.to_string())?
        )
        .map_err(|e| e.to_string())?;
        state.snapshot.lock().unwrap().log_path = Some(log.to_string_lossy().into_owned());
        let current = quarbor_installer::list(&resources)?;
        if !plan.cleanup_done {
            // A saved plan may be resumed days later. Preserve bindings added
            // since that snapshot before invoking the global uninstall again.
            let packages = legacy_packages()?;
            if let Some(latest) = make_plan(&current, &packages, parents)? {
                plan.legacy_devices.extend(latest.legacy_devices);
                plan.targets.extend(latest.targets);
            }
            plan.targets.extend(
                current
                    .iter()
                    .filter(|d| !is_legacy(d, &packages) && (d.bound || d.recovery_active))
                    .cloned(),
            );
            for devices in [&mut plan.legacy_devices, &mut plan.targets] {
                devices.sort_by_key(|d| d.instance_id.to_ascii_uppercase());
                devices.dedup_by(|a, b| a.instance_id.eq_ignore_ascii_case(&b.instance_id));
            }
            state.snapshot.lock().unwrap().devices = describe(&plan);
        }
        // A previously successful install can have been rolled back by Windows
        // (or changed while the app was closed). Retry that target as well.
        plan.installed.retain(|id| {
            current
                .iter()
                .any(|d| d.bound && d.instance_id.eq_ignore_ascii_case(id))
        });
        for device in &plan.targets {
            if !plan.installed.contains(&device.instance_id)
                && !current
                    .iter()
                    .any(|d| d.present && d.instance_id.eq_ignore_ascii_case(&device.instance_id))
            {
                return Err(format!(
                    "原设备当前离线：{}。请连接并唤醒设备后再次尝试升级；已保存设备记录。",
                    device.instance_id
                ));
            }
        }
        let mut installer = Installer {
            state: &state,
            exe: quarbor_installer::find(&resources)?,
            journal: journal_path(app)?,
            log,
        };
        // Manual installation can trigger this flow after the input worker has
        // already connected. Wait for it to drop the pipe before uninstalling.
        app.state::<crate::input_service::InputService>()
            .wait_for_driver_pause()?;
        advance(&mut plan, &mut installer)?;
        if !plan.reboot_required {
            state.update("running", "verifying", "正在确认新版驱动绑定…".into());
            let mut verified = false;
            for _ in 0..20 {
                let devices = quarbor_installer::list(&resources)?;
                if plan.targets.iter().all(|target| {
                    devices
                        .iter()
                        .any(|d| d.bound && d.instance_id.eq_ignore_ascii_case(&target.instance_id))
                }) && legacy_packages()?.is_empty()
                {
                    verified = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            if !verified {
                return Err(
                    "安装器已结束，但新版绑定或旧驱动清理尚未确认。请重启 Windows 后再次尝试升级。"
                        .into(),
                );
            }
        }
        std::fs::remove_file(&installer.journal)
            .map_err(|e| format!("驱动已升级，但无法清理升级记录：{e}"))?;
        state.update("complete", "complete", "驱动升级已完成。".into());
        state.gate.store(false, Ordering::Release);
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn device(id: &str, section: &str, bound: bool) -> Device {
            serde_json::from_value(serde_json::json!({
                "instanceId": id, "section": section, "present": true,
                "bound": bound, "recoveryActive": false,
            }))
            .unwrap()
        }

        #[test]
        fn migration_uses_actual_ble_ancestor_and_preserves_other_universal_bindings() {
            let legacy = device(
                r"HID\remote-one\keyboard",
                "QuarborHIDFilterUserDriver_Install.Modern.NT",
                false,
            );
            let parent = device(r"BTHLEDEVICE\VID_2717&PID_32B8\one", "HidBthLE.NT", false);
            let other = device(r"BTHLEDEVICE\VID_2717&PID_32B8\two", "Universal.NT", true);
            let unrelated = device(r"HID\other\keyboard", "HID_Keyboard_Inst.NT", false);
            let plan = make_plan(
                &[legacy.clone(), parent.clone(), other.clone(), unrelated],
                &BTreeSet::new(),
                |_| Ok(vec![parent.instance_id.clone()]),
            )
            .unwrap()
            .unwrap();
            assert_eq!(plan.legacy_devices[0].instance_id, legacy.instance_id);
            assert_eq!(
                plan.targets
                    .iter()
                    .map(|d| &d.instance_id)
                    .collect::<Vec<_>>(),
                vec![&parent.instance_id, &other.instance_id]
            );
        }

        #[test]
        fn detection_handles_published_names_offline_devices_and_package_only_cleanup() {
            let rc003 = device(r"HID\VID_2717&PID_32B8\legacy", LEGACY, false);
            assert!(make_plan(&[rc003], &BTreeSet::new(), |_| Ok(vec![])).is_err());
            let mut legacy = device(r"HID\usb\keyboard", "Unknown.NT", false);
            legacy.inf = "OEM42.INF".into();
            legacy.present = false;
            let packages = BTreeSet::from(["oem42.inf".to_string()]);
            let plan = make_plan(&[legacy.clone()], &packages, |_| Ok(vec![]))
                .unwrap()
                .unwrap();
            assert_eq!(plan.targets[0].instance_id, legacy.instance_id);
            assert!(!plan.targets[0].present);
            assert!(make_plan(&[], &packages, |_| unreachable!())
                .unwrap()
                .unwrap()
                .targets
                .is_empty());
            assert!(make_plan(&[], &BTreeSet::new(), |_| unreachable!())
                .unwrap()
                .is_none());
            assert!(make_plan(&[legacy], &packages, |_| Err(
                "cannot resolve ancestry".into()
            ))
            .is_err());
            let text = "QuarborHIDFilterUserDriver.dll";
            let bytes: Vec<u8> = [0xff, 0xfe]
                .into_iter()
                .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
                .collect();
            assert_eq!(inf_text(&bytes), text);
        }

        #[derive(Default)]
        struct Fake {
            calls: Vec<String>,
            saved: Option<Plan>,
            fail: Option<String>,
            reboot: bool,
        }
        impl Fake {
            fn call(&mut self, name: &str) -> Result<bool, String> {
                self.calls.push(name.into());
                if self.fail.as_deref() == Some(name) {
                    Err(format!("failed: {name}"))
                } else {
                    Ok(self.reboot)
                }
            }
        }
        impl Operations for Fake {
            fn checkpoint(&mut self, plan: &Plan) -> Result<(), String> {
                self.call("save")?;
                self.saved = Some(plan.clone());
                Ok(())
            }
            fn uninstall_all(&mut self) -> Result<bool, String> {
                self.call("uninstall-all")
            }
            fn install(&mut self, device: &Device) -> Result<bool, String> {
                self.call(&device.instance_id)
            }
        }
        fn plan() -> Plan {
            Plan {
                version: 1,
                legacy_devices: vec![device("A", LEGACY, false)],
                targets: vec![device("A", "", false), device("B", "", false)],
                cleanup_done: false,
                installed: vec![],
                reboot_required: false,
            }
        }

        #[test]
        fn persists_before_uninstall_and_resumes_after_partial_install_across_launches() {
            let mut plan = plan();
            let mut ops = Fake {
                fail: Some("B".into()),
                reboot: true,
                ..Fake::default()
            };
            assert!(advance(&mut plan, &mut ops).is_err());
            assert_eq!(
                ops.calls,
                ["save", "uninstall-all", "save", "A", "save", "B"]
            );
            let mut resumed: Plan =
                serde_json::from_slice(&serde_json::to_vec(&ops.saved.unwrap()).unwrap()).unwrap();
            assert!(resumed.reboot_required);
            let mut retry = Fake::default();
            advance(&mut resumed, &mut retry).unwrap();
            assert_eq!(retry.calls, ["save", "B", "save"]);
            assert_eq!(resumed.installed, ["A", "B"]);
        }

        #[test]
        fn save_failure_or_uac_cancellation_never_proceeds_to_install() {
            for failure in ["save", "uninstall-all"] {
                let mut plan = plan();
                let mut ops = Fake {
                    fail: Some(failure.into()),
                    ..Fake::default()
                };
                assert!(advance(&mut plan, &mut ops).is_err());
                assert!(!plan.cleanup_done);
                assert!(!ops.calls.iter().any(|call| call == "A" || call == "B"));
                ops.calls.clear();
                ops.fail = None;
                advance(&mut plan, &mut ops).unwrap();
                assert!(ops.calls.contains(&"uninstall-all".into()));
            }
        }

        #[test]
        fn journal_replacement_retains_targets_and_progress() {
            let path = std::env::temp_dir()
                .join(format!("axonkey-upgrade-test-{}.json", std::process::id()));
            let mut plan = plan();
            save(&path, &plan).unwrap();
            plan.cleanup_done = true;
            plan.installed.push("A".into());
            save(&path, &plan).unwrap();
            let loaded = load(&path).unwrap().unwrap();
            assert_eq!(loaded.targets.len(), 2);
            assert_eq!(loaded.installed, ["A"]);
            assert!(loaded.cleanup_done);
            std::fs::remove_file(path).unwrap();
        }

        #[test]
        #[ignore = "Read-only check against Windows PnP and published INF files"]
        fn reads_real_windows_migration_inventory_without_modifying_drivers() {
            let resources = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
            let devices = quarbor_installer::list(resources).unwrap();
            for device in devices.iter().filter(|d| d.is_rc003()) {
                assert!(!parents(&device.instance_id).unwrap().is_empty());
            }
            let result = make_plan(&devices, &legacy_packages().unwrap(), parents).unwrap();
            eprintln!(
                "legacy upgrade needed: {}, targets: {}",
                result.is_some(),
                result.map_or(0, |plan| plan.targets.len())
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_recheck_resets_terminal_results_and_pauses_input_again() {
        let state = UpgradeState::default();
        for previous in ["notNeeded", "dismissed", "complete", "failed"] {
            state.update(previous, "installing", "previous attempt".into());
            state.gate.store(false, Ordering::Release);
            state.begin_check();
            assert!(state.gate.load(Ordering::Acquire));
            let snapshot = state.snapshot.lock().unwrap();
            assert_eq!(snapshot.status, "checking");
            assert_eq!(snapshot.stage, "checking");
            assert!(snapshot.devices.is_empty());
            assert!(snapshot.log_path.is_none());
            assert!(!snapshot.reboot_required);
        }
    }
    #[test]
    fn only_pending_and_running_upgrades_block_native_close_and_exit() {
        let state = UpgradeState::default();
        for (status, blocks) in [
            ("checking", false),
            ("pending", true),
            ("running", true),
            ("failed", false),
            ("complete", false),
            ("dismissed", false),
        ] {
            state.update(status, "checking", String::new());
            assert_eq!(state.blocks_close(), blocks, "{status}");
        }
    }
}
