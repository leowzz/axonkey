#![cfg_attr(not(windows), allow(dead_code))]

//! Removes the legacy Axonkey input components on Windows.
//!
//! The executable is shipped beside the application in `scripts`.  Its base
//! directory is therefore the parent of the executable's directory, rather
//! than the process' current working directory.

#[cfg(not(windows))]
fn main() {
    eprintln!("uninstall-old-driver is only supported on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_app {
    use std::ffi::{OsStr, OsString};
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitStatus, Stdio};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ERROR_CANCELLED: i32 = 1223;
    const INTERCEPTION_FIX_SERVICE: &str = "AxonkeyInterceptionFix";
    const INTERCEPTION_FIX_DIRECTORY: &str = r"C:\Program Files\Axonkey Interception Fix";
    const INTERCEPTION_TARGETS: [(&str, &str, &str); 2] = [
        (
            "keyboard",
            r"SYSTEM\CurrentControlSet\Control\Class\{4D36E96B-E325-11CE-BFC1-08002BE10318}",
            "keyboard.sys",
        ),
        (
            "mouse",
            r"SYSTEM\CurrentControlSet\Control\Class\{4D36E96F-E325-11CE-BFC1-08002BE10318}",
            "mouse.sys",
        ),
    ];

    pub fn main() {
        let args: Vec<OsString> = std::env::args_os().skip(1).collect();
        let options = match Options::parse(&args) {
            Ok(options) => options,
            Err(error) => {
                eprintln!("{error}");
                print_usage();
                std::process::exit(2);
            }
        };

        // Status is read-only: no elevation, log files, or cleanup side effects.
        if options.status {
            match legacy_components() {
                Ok(components) => println!(
                    "{{\"action\":\"status\",\"components\":{{\"interception\":{},\"interceptionFix\":{}}}}}",
                    components.interception, components.interception_fix
                ),
                Err(error) => {
                    eprintln!("Cannot check legacy drivers: {error}");
                    std::process::exit(1);
                }
            }
            return;
        }

        let log_path = options.log_path.clone().unwrap_or_else(default_log_path);
        if let Err(error) = ensure_parent(&log_path) {
            eprintln!("Cannot create the log directory: {error}");
            std::process::exit(1);
        }

        if !is_administrator() {
            match elevate(&options, &log_path) {
                Ok(code) => std::process::exit(code),
                Err(error) => {
                    append_log(
                        &log_path,
                        &format!("ERROR: administrator elevation failed: {error}"),
                    );
                    eprintln!("Administrator permission is required: {error}");
                    std::process::exit(1);
                }
            }
        }

        let mut log = match Logger::new(log_path.clone()) {
            Ok(log) => log,
            Err(error) => {
                eprintln!("Cannot open the log file: {error}");
                std::process::exit(1);
            }
        };
        log.line(&format!(
            "Old driver cleanup started. Base directory: {}",
            base_dir().display()
        ));

        if !options.confirmed && !confirm() {
            log.line("Cleanup cancelled by the user.");
            std::process::exit(2);
        }

        if let Err(error) = cleanup(&mut log) {
            log.line(&format!("ERROR: {error}"));
            eprintln!("Cleanup failed: {error}");
            std::process::exit(1);
        }
        log.line("Old driver cleanup completed successfully. Reboot may be required by Windows.");
        println!(
            "{{\"action\":\"cleanup\",\"success\":true,\"rebootRequired\":true,\"logPath\":{}}}",
            json_string(&log_path)
        );
    }

    struct Options {
        confirmed: bool,
        status: bool,
        log_path: Option<PathBuf>,
    }

    impl Options {
        fn parse(args: &[OsString]) -> Result<Self, String> {
            let mut options = Self {
                confirmed: false,
                status: false,
                log_path: None,
            };
            let mut index = 0;
            while index < args.len() {
                let arg = args[index].to_string_lossy();
                match arg.as_ref() {
                    "--confirmed" | "-y" => options.confirmed = true,
                    "--status" => options.status = true,
                    "--log-path" => {
                        index += 1;
                        let value = args.get(index).ok_or("--log-path requires a value")?;
                        options.log_path = Some(PathBuf::from(value));
                    }
                    "--help" | "-h" => {
                        print_usage();
                        std::process::exit(0);
                    }
                    other => return Err(format!("Unknown argument: {other}")),
                }
                index += 1;
            }
            Ok(options)
        }
    }

    fn print_usage() {
        eprintln!("Usage: uninstall-old-driver.exe [--confirmed] [--status] [--log-path PATH]");
    }

    fn default_log_path() -> PathBuf {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| base_dir().join("logs"))
            .join("Axonkey")
            .join("logs")
            .join("old-driver-uninstall.log")
    }

    fn base_dir() -> PathBuf {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .and_then(|scripts| scripts.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }

    fn ensure_parent(path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    struct Logger {
        file: File,
    }

    impl Logger {
        fn new(path: PathBuf) -> io::Result<Self> {
            ensure_parent(&path)?;
            let file = OpenOptions::new().create(true).append(true).open(&path)?;
            Ok(Self { file })
        }

        fn line(&mut self, message: &str) {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or_default();
            let _ = writeln!(self.file, "[{timestamp}] {message}");
            let _ = self.file.flush();
            println!("{message}");
        }
    }

    fn append_log(path: &Path, message: &str) {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{message}");
        }
    }

    fn json_string(path: &Path) -> String {
        format!(
            "\"{}\"",
            path.to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
        )
    }

    fn confirm() -> bool {
        println!("This removes the old Axonkey input components: NamedPipeServer, Frida, and Interception.");
        print!("Type UNINSTALL to continue: ");
        let _ = io::stdout().flush();
        let mut answer = String::new();
        io::stdin().read_line(&mut answer).is_ok() && answer.trim() == "UNINSTALL"
    }

    fn command(program: &str, args: &[&OsStr]) -> io::Result<(ExitStatus, String)> {
        let output = Command::new(program)
            .creation_flags(CREATE_NO_WINDOW)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()?;
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        Ok((output.status, text))
    }

    fn run_sc(args: &[&str]) -> io::Result<(ExitStatus, String)> {
        let args = args.iter().map(|arg| OsStr::new(arg)).collect::<Vec<_>>();
        command("sc.exe", &args)
    }

    #[derive(Debug, PartialEq)]
    struct LegacyComponents {
        interception: bool,
        interception_fix: bool,
    }

    fn legacy_components() -> Result<LegacyComponents, String> {
        detect_legacy_components(
            registry_service_exists,
            |class_key| registry_multi_string(class_key, "UpperFilters"),
            |path| {
                path.try_exists()
                    .map_err(|error| format!("{}: {error}", path.display()))
            },
        )
    }

    fn detect_legacy_components(
        mut service_exists: impl FnMut(&str) -> Result<bool, String>,
        mut filters: impl FnMut(&str) -> Result<Option<Vec<String>>, String>,
        mut path_exists: impl FnMut(&Path) -> Result<bool, String>,
    ) -> Result<LegacyComponents, String> {
        let mut interception = false;
        for (service, class_key, driver_file) in INTERCEPTION_TARGETS {
            let service_present = service_exists(service)?;
            let filter_present = filters(class_key)?
                .unwrap_or_default()
                .iter()
                .any(|filter| filter.eq_ignore_ascii_case(service));
            let file_present = path_exists(&system_driver_path(driver_file))?;
            interception |= service_present || filter_present || file_present;
        }
        let service_present = service_exists(INTERCEPTION_FIX_SERVICE)?;
        let directory_present = path_exists(Path::new(INTERCEPTION_FIX_DIRECTORY))?;
        Ok(LegacyComponents {
            interception,
            interception_fix: service_present || directory_present,
        })
    }

    fn registry_service_exists(service: &str) -> Result<bool, String> {
        let key_path = wide(OsStr::new(&format!(
            r"SYSTEM\CurrentControlSet\Services\{service}"
        )));
        unsafe {
            let mut key = std::ptr::null_mut();
            let result = RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                key_path.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut key,
            );
            if result == ERROR_FILE_NOT_FOUND {
                return Ok(false);
            }
            if result != ERROR_SUCCESS {
                return Err(format!(
                    "Cannot read service {service}: RegOpenKeyExW returned {result}"
                ));
            }
            RegCloseKey(key);
        }
        Ok(true)
    }

    fn cleanup(log: &mut Logger) -> Result<(), String> {
        let services =
            discover_services().map_err(|error| format!("cannot enumerate services: {error}"))?;
        let mut service_paths = Vec::new();
        for service in services {
            let details = run_sc(&["qc", &service])
                .map_err(|error| format!("cannot inspect service {service}: {error}"))?;
            let details_text = details.1.clone();
            let identity = details_text
                .lines()
                .filter(|line| {
                    let upper = line.trim_start().to_ascii_uppercase();
                    upper.starts_with("DISPLAY_NAME") || upper.starts_with("BINARY_PATH_NAME")
                })
                .collect::<Vec<_>>()
                .join("\n");
            let lower = format!("{service}\n{identity}").to_ascii_lowercase();
            let kind = if lower.contains("namedpipeserver") {
                Some("NamedPipeServer")
            } else if lower.contains("frida") {
                Some("Frida")
            } else {
                None
            };
            let Some(kind) = kind else { continue };
            if let Some(path) = parse_binary_path(&details_text) {
                service_paths.push((kind, path));
            }
            log.line(&format!("Stopping {kind} service: {service}"));
            let (_, stop_output) = run_sc(&["stop", &service])
                .map_err(|error| format!("cannot stop service {service}: {error}"))?;
            log_output(log, &format!("sc stop {service}"), &stop_output);
            wait_for_service_stop(&service);
            let (_, delete_output) = run_sc(&["delete", &service])
                .map_err(|error| format!("cannot delete service {service}: {error}"))?;
            log_output(log, &format!("sc delete {service}"), &delete_output);
        }

        stop_frida_processes(log)?;
        for (kind, path) in service_paths {
            remove_component_path(log, kind, &path);
        }
        remove_named_files(log, "namedpipeserver");
        remove_named_files(log, "frida");

        uninstall_axonkey_interception_fix(log);
        uninstall_interception(log);
        remove_vendor_payload(log, "interception-fix", "Interception Fix");
        remove_vendor_payload(log, "interception", "Interception");
        Ok(())
    }

    fn remove_vendor_payload(log: &mut Logger, directory: &str, label: &str) {
        let root = base_dir();
        let path = root.join("vendor").join(directory);
        if !root.is_absolute() || !path.starts_with(&root) {
            log.line(&format!(
                "WARNING: cannot resolve the {label} payload directory."
            ));
            return;
        }
        match fs::remove_dir_all(&path) {
            Ok(()) => log.line(&format!("Deleted {label} payload: {}", path.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                log.line(&format!("{label} payload is absent: {}", path.display()));
            }
            Err(error) => {
                log.line(&format!(
                    "Could not delete {label} payload {}: {error}. Scheduling remaining paths for deletion after reboot.",
                    path.display()
                ));
                if let Err(error) = visit_deletion_paths(&path, &mut |remaining| {
                    if schedule_delete_on_reboot(remaining) {
                        log.line(&format!(
                            "Scheduled deletion after reboot: {}",
                            remaining.display()
                        ));
                    } else {
                        let error = io::Error::last_os_error();
                        log.line(&format!(
                            "WARNING: cannot schedule deletion after reboot for {}: {error}",
                            remaining.display()
                        ));
                    }
                }) {
                    log.line(&format!(
                        "WARNING: could not enumerate all remaining {label} payload paths: {error}"
                    ));
                }
            }
        }
    }

    // MoveFileExW only removes empty directories at boot. Register children
    // before their parents, and never follow junctions or symbolic links.
    fn visit_deletion_paths(path: &Path, visit: &mut impl FnMut(&Path)) -> io::Result<()> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut first_error = None;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            match fs::read_dir(path) {
                Ok(entries) => {
                    for entry in entries {
                        let result =
                            entry.and_then(|entry| visit_deletion_paths(&entry.path(), visit));
                        if let Err(error) = result {
                            first_error.get_or_insert(error);
                        }
                    }
                }
                Err(error) => {
                    first_error = Some(error);
                }
            }
        }
        visit(path);
        first_error.map_or(Ok(()), Err)
    }

    fn uninstall_axonkey_interception_fix(log: &mut Logger) {
        const SERVICE: &str = INTERCEPTION_FIX_SERVICE;
        let service_present = match run_sc(&["qc", SERVICE]) {
            Ok((status, _output)) => {
                if !status.success() {
                    log.line(&format!("{SERVICE} service is not registered."));
                    false
                } else {
                    true
                }
            }
            Err(error) => {
                log.line(&format!("WARNING: cannot query {SERVICE} service: {error}"));
                false
            }
        };

        if service_present {
            log.line(&format!("Stopping service: {SERVICE}"));
            match run_sc(&["stop", SERVICE]) {
                Ok((_, output)) => log_output(log, &format!("sc stop {SERVICE}"), &output),
                Err(error) => log.line(&format!("WARNING: cannot stop {SERVICE} service: {error}")),
            }
            wait_for_service_stop(SERVICE);

            match run_sc(&["delete", SERVICE]) {
                Ok((_, output)) => log_output(log, &format!("sc delete {SERVICE}"), &output),
                Err(error) => log.line(&format!(
                    "WARNING: cannot delete {SERVICE} service: {error}"
                )),
            }
        }

        let install_dir = PathBuf::from(INTERCEPTION_FIX_DIRECTORY);
        if install_dir.exists() {
            remove_path(
                log,
                &install_dir,
                "AxonkeyInterceptionFix installation directory",
            );
        }
    }

    fn discover_services() -> io::Result<Vec<String>> {
        let (_, output) = run_sc(&["query", "type=", "service", "state=", "all"])?;
        let mut names = Vec::new();
        for line in output.lines() {
            let line = line.trim();
            if let Some(name) = line.strip_prefix("SERVICE_NAME:") {
                let name = name.trim();
                if !name.is_empty() {
                    names.push(name.to_string());
                }
            }
        }
        Ok(names)
    }

    fn wait_for_service_stop(service: &str) {
        for _ in 0..50 {
            if let Ok((_, output)) = run_sc(&["query", service]) {
                let lower = output.to_ascii_lowercase();
                if lower.contains("stopped") || lower.contains("does not exist") {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn stop_frida_processes(log: &mut Logger) -> Result<(), String> {
        let (_, output) = command(
            "tasklist.exe",
            &[OsStr::new("/fo"), OsStr::new("csv"), OsStr::new("/nh")],
        )
        .map_err(|error| format!("cannot enumerate processes: {error}"))?;
        for line in output.lines() {
            let Some(name) = line.split(',').next().map(|value| value.trim_matches('"')) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            if !lower.contains("frida") || !lower.ends_with(".exe") {
                continue;
            }
            log.line(&format!("Stopping Frida process: {name}"));
            let (_, output) = command(
                "taskkill.exe",
                &[OsStr::new("/F"), OsStr::new("/IM"), OsStr::new(name)],
            )
            .map_err(|error| format!("cannot stop process {name}: {error}"))?;
            log_output(log, &format!("taskkill {name}"), &output);
        }
        Ok(())
    }

    fn log_output(log: &mut Logger, label: &str, output: &str) {
        for line in output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            log.line(&format!("{label}: {line}"));
        }
    }

    fn parse_binary_path(output: &str) -> Option<PathBuf> {
        let line = output
            .lines()
            .find(|line| line.trim_start().starts_with("BINARY_PATH_NAME"))?;
        let value = line.split_once(':')?.1.trim();
        let path = if let Some(rest) = value.strip_prefix('"') {
            rest.split('"').next().unwrap_or(rest).to_string()
        } else {
            value.split_whitespace().next().unwrap_or(value).to_string()
        };
        let path = expand_environment_variables(path.trim_start_matches(r"\??\"));
        let path = PathBuf::from(path);
        path.is_file().then_some(path)
    }

    fn expand_environment_variables(value: &str) -> String {
        let mut result = String::new();
        let mut rest = value;
        while let Some(start) = rest.find('%') {
            result.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            let Some(end) = after.find('%') else {
                result.push('%');
                rest = after;
                continue;
            };
            let name = &after[..end];
            result.push_str(&std::env::var(name).unwrap_or_else(|_| format!("%{name}%")));
            rest = &after[end + 1..];
        }
        result.push_str(rest);
        result
    }

    fn remove_component_path(log: &mut Logger, kind: &str, path: &Path) {
        let lower = path.to_string_lossy().to_ascii_lowercase();
        let allowed = lower.contains(&kind.to_ascii_lowercase()) || path.starts_with(base_dir());
        if !allowed {
            return;
        }
        remove_path(log, path, &format!("{kind} service binary"));
    }

    fn remove_named_files(log: &mut Logger, needle: &str) {
        let root = base_dir();
        let mut matches = Vec::new();
        collect_named_paths(&root, needle, &mut matches);
        for path in matches {
            remove_path(log, &path, &format!("{needle} residual"));
        }
    }

    fn collect_named_paths(root: &Path, needle: &str, matches: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if name.contains(needle) {
                matches.push(path.clone());
                continue;
            }
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                collect_named_paths(&path, needle, matches);
            }
        }
    }

    fn remove_path(log: &mut Logger, path: &Path, label: &str) {
        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(()) => log.line(&format!("Deleted {label}: {}", path.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => log.line(&format!(
                "Could not delete {label} {}: {error}",
                path.display()
            )),
        }
    }

    fn uninstall_interception(log: &mut Logger) {
        for (service, class_key, driver_file) in INTERCEPTION_TARGETS {
            let filters = match registry_multi_string(class_key, "UpperFilters") {
                Ok(filters) => filters,
                Err(error) => {
                    log.line(&format!(
                        "WARNING: cannot read Interception {service} UpperFilters: {error}"
                    ));
                    None
                }
            };
            let has_filter = filters
                .as_ref()
                .map(|values| {
                    values
                        .iter()
                        .any(|value| value.eq_ignore_ascii_case(service))
                })
                .unwrap_or(false);
            let service_present = match run_sc(&["qc", service]) {
                Ok((status, output)) => {
                    if !status.success() && !output.trim().is_empty() {
                        log_output(log, &format!("sc qc {service}"), &output);
                    }
                    status.success()
                }
                Err(error) => {
                    log.line(&format!(
                        "WARNING: cannot query Interception {service} service: {error}"
                    ));
                    false
                }
            };

            let driver_path = system_driver_path(driver_file);
            log.line(&format!(
                "Interception {service} state: servicePresent={service_present}, filterPresent={has_filter}, filePresent={}",
                driver_path.is_file()
            ));

            if service_present {
                log.line(&format!("Stopping Interception driver service: {service}"));
                match run_sc(&["stop", service]) {
                    Ok((_, output)) => log_output(log, &format!("sc stop {service}"), &output),
                    Err(error) => log.line(&format!(
                        "WARNING: cannot stop Interception {service} service: {error}"
                    )),
                }
                wait_for_service_stop(service);
            }

            if has_filter {
                let remaining = filters
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|value| !value.eq_ignore_ascii_case(service))
                    .collect::<Vec<_>>();
                match registry_set_multi_string(class_key, "UpperFilters", &remaining) {
                    Ok(()) => log.line(&format!(
                        "Removed Interception {service} from {class_key} UpperFilters"
                    )),
                    Err(error) => log.line(&format!(
                        "WARNING: cannot update {service} UpperFilters: {error}"
                    )),
                }
            }

            if service_present {
                match run_sc(&["delete", service]) {
                    Ok((_, output)) => log_output(log, &format!("sc delete {service}"), &output),
                    Err(error) => log.line(&format!(
                        "WARNING: cannot delete Interception {service} service: {error}"
                    )),
                }
            }

            if driver_path.is_file() {
                remove_driver_file(log, &driver_path);
            }
        }
    }

    fn system_driver_path(file_name: &str) -> PathBuf {
        std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("drivers")
            .join(file_name)
    }

    fn remove_driver_file(log: &mut Logger, path: &Path) {
        match fs::remove_file(path) {
            Ok(()) => log.line(&format!(
                "Deleted Interception driver file: {}",
                path.display()
            )),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                log.line(&format!(
                    "WARNING: could not delete Interception driver file {}: {error}",
                    path.display()
                ));
                if schedule_delete_on_reboot(path) {
                    log.line(&format!(
                        "Scheduled Interception driver file for deletion after reboot: {}",
                        path.display()
                    ));
                }
            }
        }
    }

    fn schedule_delete_on_reboot(path: &Path) -> bool {
        let path_w = wide(path.as_os_str());
        unsafe {
            MoveFileExW(
                path_w.as_ptr(),
                std::ptr::null(),
                MOVEFILE_DELAY_UNTIL_REBOOT | MOVEFILE_WRITE_THROUGH,
            ) != 0
        }
    }

    fn registry_multi_string(
        key_path: &str,
        value_name: &str,
    ) -> Result<Option<Vec<String>>, String> {
        let Some((value_type, bytes)) = registry_value(key_path, value_name)? else {
            return Ok(None);
        };
        if value_type != REG_MULTI_SZ && value_type != REG_SZ {
            return Err(format!("unexpected registry value type {value_type}"));
        }
        Ok(Some(decode_multi_string(&bytes)))
    }

    fn registry_value(key_path: &str, value_name: &str) -> Result<Option<(u32, Vec<u8>)>, String> {
        let key_path_w = wide(OsStr::new(key_path));
        let value_name_w = wide(OsStr::new(value_name));
        unsafe {
            let mut key = std::ptr::null_mut();
            let result = RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                key_path_w.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut key,
            );
            if result == ERROR_FILE_NOT_FOUND {
                return Ok(None);
            }
            if result != ERROR_SUCCESS {
                return Err(format!("RegOpenKeyExW returned {result}"));
            }
            let mut value_type = 0;
            let mut size = 0;
            let result = RegQueryValueExW(
                key,
                value_name_w.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                std::ptr::null_mut(),
                &mut size,
            );
            if result == ERROR_FILE_NOT_FOUND {
                RegCloseKey(key);
                return Ok(None);
            }
            if result != ERROR_SUCCESS && result != ERROR_MORE_DATA {
                RegCloseKey(key);
                return Err(format!("RegQueryValueExW returned {result}"));
            }
            let mut bytes = vec![0; size as usize];
            let result = RegQueryValueExW(
                key,
                value_name_w.as_ptr(),
                std::ptr::null_mut(),
                &mut value_type,
                bytes.as_mut_ptr(),
                &mut size,
            );
            RegCloseKey(key);
            if result != ERROR_SUCCESS {
                return Err(format!("RegQueryValueExW returned {result}"));
            }
            bytes.truncate(size as usize);
            Ok(Some((value_type, bytes)))
        }
    }

    fn decode_multi_string(bytes: &[u8]) -> Vec<String> {
        let values = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&values)
            .split('\0')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    }

    fn registry_set_multi_string(
        key_path: &str,
        value_name: &str,
        values: &[String],
    ) -> Result<(), String> {
        let key_path_w = wide(OsStr::new(key_path));
        let value_name_w = wide(OsStr::new(value_name));
        unsafe {
            let mut key = std::ptr::null_mut();
            let result = RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                key_path_w.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut key,
            );
            if result != ERROR_SUCCESS {
                return Err(format!("RegOpenKeyExW returned {result}"));
            }
            if values.is_empty() {
                let result = RegDeleteValueW(key, value_name_w.as_ptr());
                RegCloseKey(key);
                if result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND {
                    return Ok(());
                }
                return Err(format!("RegDeleteValueW returned {result}"));
            }
            let mut encoded = Vec::new();
            for value in values {
                encoded.extend(value.encode_utf16());
                encoded.push(0);
            }
            encoded.push(0);
            let bytes = std::slice::from_raw_parts(
                encoded.as_ptr() as *const u8,
                encoded.len() * std::mem::size_of::<u16>(),
            );
            let result = RegSetValueExW(
                key,
                value_name_w.as_ptr(),
                0,
                REG_MULTI_SZ,
                bytes.as_ptr(),
                bytes.len() as u32,
            );
            RegCloseKey(key);
            if result == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(format!("RegSetValueExW returned {result}"))
            }
        }
    }

    fn is_administrator() -> bool {
        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut size = 0;
            let result = GetTokenInformation(
                token,
                TOKEN_ELEVATION_INFORMATION,
                &mut elevation as *mut _ as *mut _,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            );
            CloseHandle(token);
            result != 0 && elevation.TokenIsElevated != 0
        }
    }

    fn elevate(options: &Options, log_path: &Path) -> Result<i32, String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut args = Vec::new();
        if options.status {
            args.push(OsString::from("--status"));
        }
        if options.confirmed {
            args.push(OsString::from("--confirmed"));
        }
        args.push(OsString::from("--log-path"));
        args.push(log_path.as_os_str().to_os_string());
        let parameters = args
            .iter()
            .map(|arg| quote_argument(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let exe_w = wide(exe.as_os_str());
        let verb_w = wide(OsStr::new("runas"));
        let params_w = wide(OsStr::new(&parameters));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            hwnd: std::ptr::null_mut(),
            lpVerb: verb_w.as_ptr(),
            lpFile: exe_w.as_ptr(),
            lpParameters: params_w.as_ptr(),
            lpDirectory: std::ptr::null(),
            nShow: SW_SHOWNORMAL,
            hInstApp: std::ptr::null_mut(),
            lpIDList: std::ptr::null_mut(),
            lpClass: std::ptr::null(),
            hkeyClass: std::ptr::null_mut(),
            dwHotKey: 0,
            hIcon: std::ptr::null_mut(),
            hProcess: std::ptr::null_mut(),
        };
        let launched = unsafe { ShellExecuteExW(&mut info) };
        if launched == 0 {
            let code = unsafe { GetLastError() } as i32;
            if code == ERROR_CANCELLED {
                return Err("the administrator prompt was cancelled".into());
            }
            return Err(format!("ShellExecuteExW failed with code {code}"));
        }
        if info.hProcess.is_null() {
            return Ok(0);
        }
        unsafe {
            WaitForSingleObject(info.hProcess, INFINITE);
            let mut code = 1;
            let _ = GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            Ok(code as i32)
        }
    }

    fn quote_argument(argument: &OsStr) -> String {
        let value = argument.to_string_lossy();
        if value.is_empty() || value.chars().any(char::is_whitespace) {
            format!("\"{}\"", value.replace('"', "\\\""))
        } else {
            value.into_owned()
        }
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::fs::OpenOptionsExt;

        #[test]
        fn detects_each_legacy_service_independently() {
            for service in ["keyboard", "mouse", INTERCEPTION_FIX_SERVICE] {
                let result = detect_legacy_components(
                    |name| Ok(name == service),
                    |_| Ok(None),
                    |_| Ok(false),
                )
                .unwrap();
                assert_eq!(result.interception, service != INTERCEPTION_FIX_SERVICE);
                assert_eq!(result.interception_fix, service == INTERCEPTION_FIX_SERVICE);
            }
        }

        #[test]
        fn detects_orphaned_case_insensitive_filters_without_services() {
            for (service, class_key, _) in INTERCEPTION_TARGETS {
                let result = detect_legacy_components(
                    |_| Ok(false),
                    |key| {
                        Ok(Some(if key == class_key {
                            vec!["kbdclass".into(), service.to_uppercase()]
                        } else {
                            vec!["mouclass".into()]
                        }))
                    },
                    |_| Ok(false),
                )
                .unwrap();
                assert!(result.interception);
                assert!(!result.interception_fix);
            }
        }

        #[test]
        fn detects_driver_files_and_the_repair_installation_after_services_are_removed() {
            for file in ["keyboard.sys", "mouse.sys", "Axonkey Interception Fix"] {
                let result = detect_legacy_components(
                    |_| Ok(false),
                    |_| Ok(None),
                    |path| Ok(path.file_name() == Some(OsStr::new(file))),
                )
                .unwrap();
                assert_eq!(result.interception, file != "Axonkey Interception Fix");
                assert_eq!(result.interception_fix, file == "Axonkey Interception Fix");
            }
        }

        #[test]
        fn standard_windows_filters_do_not_count_as_legacy_drivers() {
            let result = detect_legacy_components(
                |_| Ok(false),
                |_| Ok(Some(vec!["kbdclass".into(), "mouclass".into()])),
                |_| Ok(false),
            )
            .unwrap();
            assert_eq!(
                result,
                LegacyComponents {
                    interception: false,
                    interception_fix: false
                }
            );
        }

        #[test]
        fn unreadable_services_filters_or_files_are_errors_instead_of_clear_results() {
            assert!(detect_legacy_components(
                |_| Err("service access denied".into()),
                |_| Ok(None),
                |_| Ok(false),
            )
            .is_err());
            assert!(detect_legacy_components(
                |_| Ok(false),
                |_| Err("filter access denied".into()),
                |_| Ok(false),
            )
            .is_err());
            assert!(detect_legacy_components(
                |_| Ok(false),
                |_| Ok(None),
                |_| Err("file access denied".into()),
            )
            .is_err());
        }

        struct TestDirectory(PathBuf);

        impl TestDirectory {
            fn new() -> Self {
                let unique = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let path = std::env::temp_dir().join(format!(
                    "axonkey-cleanup-test-{}-{unique}",
                    std::process::id()
                ));
                fs::create_dir(&path).unwrap();
                Self(path)
            }
        }

        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn locked_payload_is_visited_before_its_parent_directories() {
            let directory = TestDirectory::new();
            let nested = directory.0.join("nested");
            fs::create_dir(&nested).unwrap();
            let locked_path = nested.join("locked.exe");
            let locked = OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(0)
                .open(&locked_path)
                .unwrap();

            assert!(fs::remove_dir_all(&directory.0).is_err());
            let mut queued = Vec::new();
            visit_deletion_paths(&directory.0, &mut |path| queued.push(path.to_path_buf()))
                .unwrap();
            assert_eq!(queued, vec![locked_path, nested, directory.0.clone()]);
            // The visitor can be tested without registering any real reboot deletions.
            drop(locked);
        }

        #[test]
        fn missing_payload_does_not_queue_any_deletions() {
            let directory = TestDirectory::new();
            let mut queued = Vec::new();
            visit_deletion_paths(&directory.0.join("absent"), &mut |path| {
                queued.push(path.to_path_buf());
            })
            .unwrap();
            assert!(queued.is_empty());
        }
    }

    type Handle = *mut std::ffi::c_void;
    const HKEY_LOCAL_MACHINE: Handle = (-2_147_483_646isize) as Handle;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const KEY_SET_VALUE: u32 = 0x0002;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_MORE_DATA: i32 = 234;
    const REG_SZ: u32 = 1;
    const REG_MULTI_SZ: u32 = 7;
    const MOVEFILE_DELAY_UNTIL_REBOOT: u32 = 0x0000_0004;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_ELEVATION_INFORMATION: u32 = 20;
    const SW_SHOWNORMAL: i32 = 1;
    const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
    const INFINITE: u32 = 0xffff_ffff;
    #[allow(non_snake_case)]
    #[repr(C)]
    struct SHELLEXECUTEINFOW {
        cbSize: u32,
        fMask: u32,
        hwnd: Handle,
        lpVerb: *const u16,
        lpFile: *const u16,
        lpParameters: *const u16,
        lpDirectory: *const u16,
        nShow: i32,
        hInstApp: Handle,
        lpIDList: *mut std::ffi::c_void,
        lpClass: *const u16,
        hkeyClass: Handle,
        dwHotKey: u32,
        hIcon: Handle,
        hProcess: Handle,
    }
    #[allow(non_snake_case)]
    #[repr(C)]
    struct TOKEN_ELEVATION {
        TokenIsElevated: u32,
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: Handle,
            sub_key: *const u16,
            options: u32,
            access: u32,
            result: *mut Handle,
        ) -> i32;
        fn RegCloseKey(key: Handle) -> i32;
        fn RegQueryValueExW(
            key: Handle,
            value_name: *const u16,
            reserved: *mut u32,
            value_type: *mut u32,
            data: *mut u8,
            data_size: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: Handle,
            value_name: *const u16,
            reserved: u32,
            value_type: u32,
            data: *const u8,
            data_size: u32,
        ) -> i32;
        fn RegDeleteValueW(key: Handle, value_name: *const u16) -> i32;
        fn OpenProcessToken(handle: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            class: u32,
            info: *mut std::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut SHELLEXECUTEINFOW) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
        fn GetLastError() -> u32;
    }
}

#[cfg(windows)]
fn main() {
    windows_app::main();
}
