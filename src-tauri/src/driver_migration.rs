use std::sync::Mutex;
use tauri::Manager;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    status: String,
    message: String,
    devices: Vec<String>,
    reboot_required: bool,
    log_path: Option<String>,
}

pub(crate) struct MigrationState(Mutex<Snapshot>);

impl Default for MigrationState {
    fn default() -> Self {
        Self(Mutex::new(Snapshot {
            status: "checking".into(),
            message: "正在检查旧版按键驱动…".into(),
            devices: vec![],
            reboot_required: false,
            log_path: None,
        }))
    }
}

impl MigrationState {
    pub fn blocks_close(&self) -> bool {
        !matches!(self.0.lock().unwrap().status.as_str(), "ready")
    }

    fn update(&self, status: &str, message: impl Into<String>) {
        let mut snapshot = self.0.lock().unwrap();
        snapshot.status = status.into();
        snapshot.message = message.into();
    }
}

#[tauri::command]
pub(crate) fn get_driver_migration(app: tauri::AppHandle) -> Option<Snapshot> {
    app.try_state::<MigrationState>()
        .map(|s| s.0.lock().unwrap().clone())
}

#[tauri::command]
pub(crate) async fn run_driver_migration(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = app.state::<MigrationState>();
        {
            let mut snapshot = state.0.lock().unwrap();
            if !matches!(snapshot.status.as_str(), "required" | "failed") {
                return Err("当前没有可执行的驱动迁移。".into());
            }
            snapshot.status = "running".into();
            snapshot.message = "正在准备升级…".into();
        }
        let worker = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || windows::execute(&worker))
            .await
            .map_err(|e| format!("驱动迁移任务异常：{e}"))
            .and_then(|result| result);
        if let Err(error) = result {
            windows::fail(&app, error);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("仅 Windows 支持驱动迁移。".into())
    }
}

#[cfg(windows)]
pub(crate) fn initialize(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = windows::check(&app) {
            windows::fail(&app, error);
        }
    });
}

#[tauri::command]
pub(crate) async fn check_driver_migration(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let state = app.state::<MigrationState>();
        {
            let mut snapshot = state.0.lock().unwrap();
            if snapshot.status != "ready" {
                return Ok(());
            }
            *snapshot = MigrationState::default().0.into_inner().unwrap();
        }
        let worker = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || windows::check(&worker))
            .await
            .map_err(|e| format!("驱动检查任务异常：{e}"))
            .and_then(|result| result);
        if let Err(error) = result {
            windows::fail(&app, error);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("仅 Windows 支持驱动迁移。".into())
    }
}

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
    pub(super) struct Plan {
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
            .join("quarbor-device-migration.json"))
    }

    fn load(path: &Path) -> Result<Option<Plan>, String> {
        match std::fs::read(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("无法读取迁移记录：{e}")),
            Ok(bytes) => {
                let plan: Plan =
                    serde_json::from_slice(&bytes).map_err(|e| format!("迁移记录损坏：{e}"))?;
                if plan.version != 1 {
                    return Err("不支持的迁移记录版本。".into());
                }
                Ok(Some(plan))
            }
        }
    }

    fn save(path: &Path, plan: &Plan) -> Result<(), String> {
        use std::io::Write;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        // Keep the only copy of the device IDs intact until its replacement is durable.
        let temp = path.with_extension("tmp");
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(temp, path).map_err(|e| format!("无法保存迁移记录：{e}"))
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
        let legacy: Vec<_> = devices.iter().filter(|d| is_legacy(d, packages)).collect();
        if legacy.is_empty() {
            return Ok(None);
        }
        let mut targets = vec![];
        for device in &legacy {
            let mut target = (*device).clone();
            if device.instance_id.to_ascii_uppercase().starts_with("HID\\") {
                if let Some(parent) = ancestors(&device.instance_id)?
                    .into_iter()
                    .find(|id| id.to_ascii_uppercase().starts_with("BTHLEDEVICE\\"))
                {
                    // The ancestor need not appear in the installer's HID enumeration.
                    target.instance_id = parent;
                }
            }
            targets.push(target);
        }
        // uninstall-all removes Universal bindings too, including other physical devices.
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
            legacy_devices: legacy.into_iter().cloned().collect(),
            targets,
            cleanup_done: false,
            installed: vec![],
            reboot_required: false,
        }))
    }

    pub(super) fn prepare(app: &tauri::AppHandle) -> Result<Option<Plan>, String> {
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

    pub(super) fn publish_plan(app: &tauri::AppHandle, plan: &Plan) {
        let state = app.state::<MigrationState>();
        let mut snapshot = state.0.lock().unwrap();
        snapshot.devices = plan
            .targets
            .iter()
            .map(|d| {
                if d.name.is_empty() {
                    d.instance_id.clone()
                } else {
                    format!("{} · {}", d.name, d.instance_id)
                }
            })
            .collect();
        snapshot.reboot_required = plan.reboot_required;
    }

    pub(super) fn fail(app: &tauri::AppHandle, error: String) {
        log::error!(target: "axonkey::driver_migration", "{error}");
        app.state::<MigrationState>().update("failed", error);
        crate::show_main_window(app);
    }

    pub(super) fn finish(app: &tauri::AppHandle) -> Result<(), String> {
        if let Some(input) = app.try_state::<crate::input_service::InputService>() {
            input.resume_after_driver_migration();
            app.state::<crate::DeviceManager>()
                .resume_after_driver_migration();
        } else {
            crate::start_device_services(app)?;
        }
        app.state::<MigrationState>()
            .update("ready", "驱动检查完成，无待迁移设备。");
        Ok(())
    }

    pub(super) fn check(app: &tauri::AppHandle) -> Result<(), String> {
        if let Some(plan) = prepare(app)? {
            publish_plan(app, &plan);
            app.state::<MigrationState>().update(
                "required",
                "检测到旧版按键驱动，已保存原设备清单。请开始升级。",
            );
            crate::show_main_window(app);
            Ok(())
        } else {
            finish(app)
        }
    }

    trait Operations {
        fn checkpoint(&mut self, plan: &Plan) -> Result<(), String>;
        fn uninstall_all(&mut self) -> Result<bool, String>;
        fn install(&mut self, device: &Device) -> Result<bool, String>;
    }

    fn advance(plan: &mut Plan, ops: &mut impl Operations) -> Result<(), String> {
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
        state: &'a MigrationState,
        exe: PathBuf,
        journal: PathBuf,
        log: PathBuf,
    }

    impl Operations for Installer<'_> {
        fn checkpoint(&mut self, plan: &Plan) -> Result<(), String> {
            self.state.0.lock().unwrap().reboot_required = plan.reboot_required;
            save(&self.journal, plan)
        }
        fn uninstall_all(&mut self) -> Result<bool, String> {
            self.state
                .update("running", "正在卸载旧版驱动，请允许管理员授权…");
            let reply =
                quarbor_installer::invoke(&self.exe, "uninstall-all", None, Some(&self.log))?;
            let devices = quarbor_installer::invoke(&self.exe, "list", None, None)?;
            let packages = legacy_packages()?;
            if devices.devices.iter().any(|d| is_legacy(d, &packages)) {
                return Err("旧驱动仍绑定在设备上，尚未开始安装新版。请重启 Windows 后重试；原设备清单已保存。".into());
            }
            Ok(reply.reboot_required || reply.exit_code == 3010)
        }
        fn install(&mut self, device: &Device) -> Result<bool, String> {
            self.state.update(
                "running",
                format!("正在安装新版驱动：{}", device.instance_id),
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
        let Some(mut plan) = prepare(app)? else {
            return finish(app);
        };
        let state = app.state::<MigrationState>();
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        let current = quarbor_installer::list(&resources)?;
        if !plan.cleanup_done {
            let packages = legacy_packages()?;
            // A resumed journal must also preserve bindings added while the app was closed.
            if let Some(latest) = make_plan(&current, &packages, parents)? {
                plan.targets.extend(latest.targets);
                plan.legacy_devices.extend(latest.legacy_devices);
            }
            plan.targets.extend(
                current
                    .iter()
                    .filter(|d| !is_legacy(d, &packages) && (d.bound || d.recovery_active))
                    .cloned(),
            );
            plan.targets
                .sort_by_key(|d| d.instance_id.to_ascii_uppercase());
            plan.targets
                .dedup_by(|a, b| a.instance_id.eq_ignore_ascii_case(&b.instance_id));
            plan.legacy_devices
                .sort_by_key(|d| d.instance_id.to_ascii_uppercase());
            plan.legacy_devices
                .dedup_by(|a, b| a.instance_id.eq_ignore_ascii_case(&b.instance_id));
        }
        plan.installed.retain(|id| {
            current
                .iter()
                .any(|d| d.bound && d.instance_id.eq_ignore_ascii_case(id))
        });
        publish_plan(app, &plan);
        let log = crate::driver_log_path("input", "migration")?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .map_err(|e| e.to_string())?;
        state.0.lock().unwrap().log_path = Some(log.to_string_lossy().into_owned());
        let mut installer = Installer {
            state: &state,
            exe: quarbor_installer::find(&resources)?,
            journal: journal_path(app)?,
            log,
        };
        if let Some(input) = app.try_state::<crate::input_service::InputService>() {
            app.state::<crate::DeviceManager>()
                .pause_for_driver_migration();
            input.pause_for_driver_migration()?;
        }
        advance(&mut plan, &mut installer)?;
        state.update("running", "正在确认所有设备已绑定新版驱动…");
        for _ in 0..10 {
            let devices = quarbor_installer::list(&resources)?;
            let packages = legacy_packages()?;
            if plan.targets.iter().all(|target| {
                devices
                    .iter()
                    .any(|d| d.bound && d.instance_id.eq_ignore_ascii_case(&target.instance_id))
            }) && !devices.iter().any(|d| is_legacy(d, &packages))
            {
                std::fs::remove_file(journal_path(app)?)
                    .map_err(|e| format!("无法清除已完成的迁移记录：{e}"))?;
                finish(app)?;
                state.update("ready", "新版驱动已安装，设备服务已恢复。");
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        Err(if plan.reboot_required {
            "Windows 要求重启。请重启电脑后重新打开 Axonkey，迁移记录已保存。"
        } else {
            "部分设备尚未确认绑定新版驱动。请连接并唤醒设备后重试；迁移记录已保存。"
        }
        .into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn device(id: &str, old: bool, bound: bool) -> Device {
            Device {
                instance_id: id.into(),
                hardware_id: String::new(),
                present: true,
                bound,
                recovery_active: false,
                name: "remote".into(),
                inf: if old { "oem42.inf" } else { "oem88.inf" }.into(),
                section: "HidDevice.NT".into(),
            }
        }
        fn packages() -> BTreeSet<String> {
            BTreeSet::from(["oem42.inf".into()])
        }

        #[test]
        fn uses_actual_bluetooth_ancestor_even_when_not_in_installer_list() {
            let source = device(r"HID\VID_2717&PID_32B8\one", true, false);
            let another = device(r"BTHLEDEVICE\VID_2717&PID_32B8\two", false, false);
            let plan = make_plan(&[source.clone(), another], &packages(), |id| {
                assert_eq!(id, source.instance_id);
                Ok(vec![r"BTHLEDEVICE\VID_2717&PID_32B8\one".into()])
            })
            .unwrap()
            .unwrap();
            assert_eq!(
                plan.targets[0].instance_id,
                r"BTHLEDEVICE\VID_2717&PID_32B8\one"
            );
            assert_eq!(plan.legacy_devices[0].instance_id, source.instance_id);
        }
        #[test]
        fn preserves_non_bluetooth_target_and_existing_universal_bindings() {
            let old = device(r"HID\USB\one", true, false);
            let existing = device(r"BTHLEDEVICE\two", false, true);
            let plan = make_plan(&[old.clone(), existing.clone()], &packages(), |_| {
                Ok(vec![r"USB\parent".into()])
            })
            .unwrap()
            .unwrap();
            assert_eq!(plan.targets.len(), 2);
            assert!(plan
                .targets
                .iter()
                .any(|d| d.instance_id == old.instance_id));
            assert!(plan
                .targets
                .iter()
                .any(|d| d.instance_id == existing.instance_id));
        }
        #[test]
        fn deduplicates_hid_children_on_same_bluetooth_parent() {
            let plan = make_plan(
                &[
                    device(r"HID\one", true, false),
                    device(r"HID\two", true, false),
                ],
                &packages(),
                |_| Ok(vec![r"BTHLEDEVICE\same".into()]),
            )
            .unwrap()
            .unwrap();
            assert_eq!(plan.targets.len(), 1);
            assert_eq!(plan.legacy_devices.len(), 2);
        }
        #[test]
        fn old_package_without_old_device_does_not_trigger_migration() {
            assert!(make_plan(
                &[device(r"BTHLEDEVICE\new", false, true)],
                &packages(),
                |_| unreachable!()
            )
            .unwrap()
            .is_none());
        }
        #[test]
        fn ancestor_lookup_failure_does_not_produce_destructive_plan() {
            assert!(
                make_plan(&[device(r"HID\one", true, false)], &packages(), |_| Err(
                    "cannot locate parent".into()
                ))
                .is_err()
            );
        }
        #[test]
        fn inf_detection_supports_utf16_windows_packages() {
            let bytes: Vec<u8> = [0xff, 0xfe]
                .into_iter()
                .chain(
                    "QuarborHIDFilterUserDriver.dll"
                        .encode_utf16()
                        .flat_map(u16::to_le_bytes),
                )
                .collect();
            assert!(inf_text(&bytes).to_ascii_lowercase().contains(LEGACY));
        }

        struct TestInstaller {
            journal: PathBuf,
            calls: Vec<String>,
            fail: Option<String>,
        }
        impl TestInstaller {
            fn new() -> Self {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                Self {
                    journal: std::env::temp_dir().join(format!(
                        "axonkey-migration-test-{}-{stamp}.json",
                        std::process::id()
                    )),
                    calls: vec![],
                    fail: None,
                }
            }
        }
        impl Drop for TestInstaller {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.journal);
            }
        }
        impl Operations for TestInstaller {
            fn checkpoint(&mut self, plan: &Plan) -> Result<(), String> {
                self.calls.push("save".into());
                if self.fail.as_deref() == Some("save") {
                    return Err("disk full".into());
                }
                save(&self.journal, plan)
            }
            fn uninstall_all(&mut self) -> Result<bool, String> {
                assert!(load(&self.journal)?.is_some());
                self.calls.push("uninstall-all".into());
                if self.fail.as_deref() == Some("uninstall-all") {
                    return Err("authorization cancelled".into());
                }
                Ok(false)
            }
            fn install(&mut self, device: &Device) -> Result<bool, String> {
                assert!(load(&self.journal)?.unwrap().cleanup_done);
                self.calls.push(device.instance_id.clone());
                if self.fail.as_ref() == Some(&device.instance_id) {
                    return Err("install failed".into());
                }
                Ok(false)
            }
        }
        fn plan() -> Plan {
            make_plan(
                &[
                    device(r"BTHLEDEVICE\one", true, false),
                    device(r"BTHLEDEVICE\two", true, false),
                ],
                &packages(),
                |_| unreachable!(),
            )
            .unwrap()
            .unwrap()
        }
        #[test]
        fn cannot_uninstall_without_durable_device_list() {
            let mut ops = TestInstaller::new();
            ops.fail = Some("save".into());
            assert!(advance(&mut plan(), &mut ops).is_err());
            assert_eq!(ops.calls, ["save"]);
        }
        #[test]
        fn uninstall_failure_blocks_installation_and_can_retry() {
            let mut ops = TestInstaller::new();
            ops.fail = Some("uninstall-all".into());
            assert!(advance(&mut plan(), &mut ops).is_err());
            assert_eq!(ops.calls, ["save", "uninstall-all"]);
            let mut resumed = load(&ops.journal).unwrap().unwrap();
            assert!(!resumed.cleanup_done);
            ops.fail = None;
            advance(&mut resumed, &mut ops).unwrap();
            assert_eq!(resumed.installed.len(), 2);
        }
        #[test]
        fn restart_resumes_partial_install_without_uninstalling_successful_devices() {
            let mut ops = TestInstaller::new();
            ops.fail = Some(r"BTHLEDEVICE\two".into());
            assert!(advance(&mut plan(), &mut ops).is_err());
            let mut resumed = load(&ops.journal).unwrap().unwrap();
            assert!(resumed.cleanup_done);
            assert_eq!(resumed.installed, [r"BTHLEDEVICE\one"]);
            ops.calls.clear();
            ops.fail = None;
            advance(&mut resumed, &mut ops).unwrap();
            assert_eq!(ops.calls, ["save", r"BTHLEDEVICE\two", "save"]);
            assert_eq!(load(&ops.journal).unwrap().unwrap().installed.len(), 2);
        }
    }
}
