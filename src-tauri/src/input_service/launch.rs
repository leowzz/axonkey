use super::NativeBehavior;
use std::collections::BTreeMap;
use std::path::Path;

const MAX_WEBSITE_URL_BYTES: usize = 2048;
const MAX_COMMAND_CHARS: usize = 4096;
const MAX_HTTP_HEADERS: usize = 16;
const MAX_HTTP_HEADER_VALUE_BYTES: usize = 2048;
const MAX_HTTP_BODY_CHARS: usize = 16_384;

fn website_target(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > MAX_WEBSITE_URL_BYTES {
        return Err("Invalid website address".into());
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("Website address contains whitespace or control characters".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "Invalid website address")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Website address must be an HTTP or HTTPS URL without credentials".into());
    }
    Ok(url.into())
}

pub(crate) fn open_website(url: &str) -> Result<(), String> {
    let target = website_target(url)?;
    open_target(&target, false)
}

fn path_target(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) || !Path::new(value).is_absolute() {
        return Err(
            "File or folder path must be an absolute path without control characters".into(),
        );
    }
    if !Path::new(value).exists() {
        return Err("File or folder does not exist".into());
    }
    Ok(value.to_owned())
}

fn application_target(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) {
        return Err("Application path contains control characters".into());
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("Application path must be absolute".into());
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    #[cfg(target_os = "macos")]
    let valid = extension == "app" && path.is_dir();
    #[cfg(not(target_os = "macos"))]
    let valid = matches!(extension.as_str(), "exe" | "com" | "lnk") && path.is_file();
    if !valid {
        return Err(
            "Application is missing or its file type is unsupported on this platform".into(),
        );
    }
    Ok(value.to_owned())
}

fn command_target(
    command: &str,
    working_directory: Option<&str>,
) -> Result<(String, Option<String>), String> {
    if command.contains('\0') {
        return Err("Command contains NUL character".into());
    }
    let trimmed = command.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_COMMAND_CHARS {
        return Err("Command must not be empty or exceed 4096 characters".into());
    }
    let directory = match working_directory
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        Some(dir) => {
            if dir.chars().any(char::is_control) || !Path::new(dir).is_absolute() {
                return Err(
                    "Working directory must be an absolute path without control characters".into(),
                );
            }
            if !Path::new(dir).is_dir() {
                return Err("Working directory does not exist".into());
            }
            Some(dir.to_owned())
        }
        None => None,
    };
    Ok((trimmed.to_owned(), directory))
}

#[derive(Debug)]
struct PreparedHttpRequest {
    method: reqwest::Method,
    url: String,
    #[cfg(not(test))]
    headers: reqwest::header::HeaderMap,
    #[cfg(test)]
    raw_headers: BTreeMap<String, String>,
    body: Option<String>,
}

fn http_request_target(
    method: &str,
    url: &str,
    headers: Option<&BTreeMap<String, String>>,
    body: Option<&str>,
) -> Result<PreparedHttpRequest, String> {
    let normalized_method = match method.trim().to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Unsupported HTTP method".into()),
    };
    let target_url = website_target(url)?;
    let mut header_map = reqwest::header::HeaderMap::new();
    #[cfg(test)]
    let mut raw_headers = BTreeMap::new();
    if let Some(entries) = headers {
        if entries.len() > MAX_HTTP_HEADERS {
            return Err("Too many HTTP headers".into());
        }
        for (raw_key, raw_val) in entries {
            let key = raw_key.trim();
            let val = raw_val.trim();
            if val.len() > MAX_HTTP_HEADER_VALUE_BYTES || val.chars().any(char::is_control) {
                return Err("Invalid HTTP header value".into());
            }
            let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| "Invalid HTTP header name".to_string())?;
            if header_map.contains_key(&name) {
                return Err("Duplicate HTTP header name".into());
            }
            let value = reqwest::header::HeaderValue::from_str(val)
                .map_err(|_| "Invalid HTTP header value".to_string())?;
            header_map.insert(name, value);
            #[cfg(test)]
            raw_headers.insert(key.to_owned(), val.to_owned());
        }
    }
    let normalized_body = match body {
        Some(text) if !text.is_empty() => {
            if text.contains('\0') || text.chars().count() > MAX_HTTP_BODY_CHARS {
                return Err("HTTP body contains NUL or exceeds length limit".into());
            }
            Some(text.to_owned())
        }
        _ => None,
    };
    Ok(PreparedHttpRequest {
        method: normalized_method,
        url: target_url,
        #[cfg(not(test))]
        headers: header_map,
        #[cfg(test)]
        raw_headers,
        body: normalized_body,
    })
}

fn execute_with(
    behavior: &NativeBehavior,
    open: impl FnOnce(&str, bool) -> Result<(), String>,
) -> Result<(), String> {
    if !behavior.enabled() {
        return Ok(());
    }
    match behavior {
        NativeBehavior::OpenPath { path, .. } => open(&path_target(path)?, false),
        NativeBehavior::OpenApp { path, .. } => open(&application_target(path)?, true),
        NativeBehavior::OpenWebsite { url, .. } => open(&website_target(url)?, false),
        _ => Ok(()),
    }
}

pub(super) fn execute(behavior: &NativeBehavior) {
    if !behavior.enabled() {
        return;
    }
    let (kind, result) = match behavior {
        NativeBehavior::OpenPath { .. } => ("openPath", execute_with(behavior, open_target)),
        NativeBehavior::OpenApp { .. } => ("openApp", execute_with(behavior, open_target)),
        NativeBehavior::OpenWebsite { .. } => ("openWebsite", execute_with(behavior, open_target)),
        NativeBehavior::RunCommand {
            command,
            working_directory,
            ..
        } => (
            "runCommand",
            command_target(command, working_directory.as_deref())
                .and_then(|(cmd, cwd)| dispatch_command(cmd, cwd)),
        ),
        NativeBehavior::HttpRequest {
            method,
            url,
            headers,
            body,
            ..
        } => (
            "httpRequest",
            http_request_target(method, url, headers.as_ref(), body.as_deref())
                .and_then(dispatch_http_request),
        ),
        _ => return,
    };
    match result {
        Ok(()) => log::info!(target: "axonkey::input", "Mapped launch: type={kind}, succeeded"),
        Err(error) => {
            log::warn!(target: "axonkey::input", "Mapped launch failed: type={kind}, error={error}")
        }
    }
}

#[cfg(not(test))]
fn dispatch_command(command: String, working_directory: Option<String>) -> Result<(), String> {
    std::thread::Builder::new()
        .name("axonkey-cmd".into())
        .spawn(move || {
            #[cfg(target_os = "macos")]
            let mut process = {
                let mut cmd = std::process::Command::new("/bin/zsh");
                cmd.arg("-lc").arg(&command);
                cmd
            };
            #[cfg(target_os = "windows")]
            let mut process = {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let mut cmd = std::process::Command::new("powershell.exe");
                cmd.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-WindowStyle",
                    "Hidden",
                    "-Command",
                    &command,
                ])
                .creation_flags(CREATE_NO_WINDOW);
                cmd
            };
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let _ = (&command, &working_directory);
                log::warn!(
                    target: "axonkey::input",
                    "Running commands is only supported on Windows and macOS"
                );
                return;
            }
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                process.stdin(std::process::Stdio::null());
                if let Some(dir) = working_directory {
                    process.current_dir(dir);
                }
                match process.output() {
                    Ok(output) if output.status.success() => {
                        log::info!(target: "axonkey::input", "Mapped command finished cleanly");
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        let snippet: String = stderr.trim().chars().take(240).collect();
                        log::warn!(
                            target: "axonkey::input",
                            "Mapped command exited with {:?}: {snippet}",
                            output.status.code()
                        );
                    }
                    Err(error) => {
                        log::warn!(target: "axonkey::input", "Mapped command failed to spawn: {error}");
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to spawn command worker: {error}"))
}

#[cfg(not(test))]
fn dispatch_http_request(prepared: PreparedHttpRequest) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        let safe_url = prepared
            .url
            .split('?')
            .next()
            .unwrap_or(&prepared.url)
            .to_owned();
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        else {
            log::warn!(target: "axonkey::input", "Mapped HTTP client initialization failed");
            return;
        };
        let mut request = client
            .request(prepared.method, &prepared.url)
            .headers(prepared.headers);
        if let Some(body) = prepared.body {
            request = request.body(body);
        }
        match request.send().await {
            Ok(response) => {
                log::info!(
                    target: "axonkey::input",
                    "Mapped HTTP request finished: url={safe_url}, status={}",
                    response.status().as_u16()
                );
            }
            Err(error) => {
                log::warn!(
                    target: "axonkey::input",
                    "Mapped HTTP request failed: url={safe_url}, error={error}"
                );
            }
        }
    });
    Ok(())
}

#[cfg(all(target_os = "windows", not(test)))]
fn open_target(target: &str, application: bool) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, mode: u32) -> i32;
        fn CoUninitialize();
    }
    struct ComApartment(bool);
    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    // Shell handlers for shortcuts and browsers can require an STA apartment.
    let _apartment = ComApartment(unsafe { CoInitializeEx(std::ptr::null_mut(), 2) } >= 0);
    let wide = |value: &std::ffi::OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<_>>();
    let file = wide(std::ffi::OsStr::new(target));
    let operation = wide(std::ffi::OsStr::new("open"));
    let directory = if application {
        Path::new(target)
            .parent()
            .map(|path| wide(path.as_os_str()))
    } else {
        None
    };
    // Pass the target directly to the OS; shell metacharacters are literal.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            directory
                .as_ref()
                .map_or(std::ptr::null(), |path| path.as_ptr()),
            1,
        )
    };
    if result <= 32 {
        return Err(format!(
            "Windows could not open the target (ShellExecute error {result})"
        ));
    }
    Ok(())
}

#[cfg(all(target_os = "macos", not(test)))]
fn open_target(target: &str, _application: bool) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/open")
        .arg("--")
        .arg(target)
        .output()
        .map_err(|error| format!("Failed to open target: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "macOS could not open the target: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(all(not(any(target_os = "windows", target_os = "macos")), not(test)))]
fn open_target(_target: &str, _application: bool) -> Result<(), String> {
    Err("Launching targets is only supported on Windows and macOS".into())
}

#[cfg(test)]
thread_local! {
    pub(super) static OPENED_TARGETS: std::cell::RefCell<Vec<(String, bool)>> = const { std::cell::RefCell::new(Vec::new()) };
    pub(super) static EXECUTED_COMMANDS: std::cell::RefCell<Vec<(String, Option<String>)>> = const { std::cell::RefCell::new(Vec::new()) };
    pub(super) static SENT_HTTP_REQUESTS: std::cell::RefCell<Vec<(String, String, BTreeMap<String, String>, Option<String>)>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn open_target(target: &str, application: bool) -> Result<(), String> {
    OPENED_TARGETS.with(|targets| targets.borrow_mut().push((target.into(), application)));
    Ok(())
}

#[cfg(test)]
fn dispatch_command(command: String, working_directory: Option<String>) -> Result<(), String> {
    EXECUTED_COMMANDS.with(|cmds| cmds.borrow_mut().push((command, working_directory)));
    Ok(())
}

#[cfg(test)]
fn dispatch_http_request(prepared: PreparedHttpRequest) -> Result<(), String> {
    SENT_HTTP_REQUESTS.with(|reqs| {
        reqs.borrow_mut().push((
            prepared.method.to_string(),
            prepared.url,
            prepared.raw_headers,
            prepared.body,
        ))
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websites_are_validated_and_passed_as_a_single_target() {
        let behavior: NativeBehavior = serde_json::from_value(serde_json::json!({
            "type": "openWebsite", "url": "https://example.com/?a=1&b=%22%26"
        }))
        .unwrap();
        assert!(behavior.enabled());
        let mut called = false;
        execute_with(&behavior, |target, application| {
            assert_eq!(target, "https://example.com/?a=1&b=%22%26");
            assert!(!application);
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(called);
        for url in [
            "",
            "example.com",
            "file:///tmp/app.exe",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "https://example.com/\n",
        ] {
            let behavior = NativeBehavior::OpenWebsite {
                enabled: true,
                url: url.into(),
            };
            assert!(execute_with(&behavior, |_, _| panic!("invalid target was launched")).is_err());
        }

        OPENED_TARGETS.with(|targets| targets.borrow_mut().clear());
        open_website("https://item.jd.com/10001234.html?sku=1&from=axonkey").unwrap();
        OPENED_TARGETS.with(|targets| {
            assert_eq!(
                targets.borrow().as_slice(),
                &[(
                    "https://item.jd.com/10001234.html?sku=1&from=axonkey".to_owned(),
                    false
                )]
            );
        });
        for invalid in [
            "javascript:alert(1)".to_owned(),
            "data:text/html,<script>alert(1)</script>".to_owned(),
            "ftp://example.com/item".to_owned(),
            "/relative/path".to_owned(),
            format!("https://example.com/{}", "a".repeat(MAX_WEBSITE_URL_BYTES)),
        ] {
            assert!(open_website(&invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn disabled_launches_do_nothing_and_opener_errors_propagate() {
        let behavior = NativeBehavior::OpenApp {
            enabled: false,
            path: String::new(),
        };
        execute_with(&behavior, |_, _| panic!("disabled action was launched")).unwrap();
        let behavior = NativeBehavior::OpenWebsite {
            enabled: true,
            url: "http://localhost:3000".into(),
        };
        assert_eq!(
            execute_with(&behavior, |_, _| Err("no browser".into())),
            Err("no browser".into())
        );
    }

    #[test]
    fn opens_existing_files_and_folders_as_literal_targets() {
        let directory = std::env::temp_dir().join(format!("axonkey-path-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("中文 & quoted file.txt");
        std::fs::write(&file, "test").unwrap();
        for path in [&directory, &file] {
            let behavior = NativeBehavior::OpenPath {
                enabled: true,
                path: path.to_str().unwrap().into(),
            };
            execute_with(&behavior, |target, application| {
                assert_eq!(target, path.to_str().unwrap());
                assert!(!application);
                Ok(())
            })
            .unwrap();
        }
        for value in ["relative.txt", "https://example.com", "", "\0"] {
            assert!(path_target(value).is_err());
        }
        let disabled = NativeBehavior::OpenPath {
            enabled: false,
            path: String::new(),
        };
        execute_with(&disabled, |_, _| panic!("disabled target opened")).unwrap();
        let behavior = NativeBehavior::OpenPath {
            enabled: true,
            path: file.to_str().unwrap().into(),
        };
        assert!(execute_with(&behavior, |_, _| Err("No associated application".into())).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
        assert!(execute_with(&behavior, |_, _| panic!("missing target opened")).is_err());
    }

    #[test]
    fn application_requires_an_existing_supported_absolute_path() {
        let directory = std::env::temp_dir().join(format!("axonkey-launch-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        #[cfg(target_os = "macos")]
        let path = directory.join("Test & Space.app");
        #[cfg(not(target_os = "macos"))]
        let path = directory.join("Test & Space.exe");
        #[cfg(target_os = "macos")]
        std::fs::create_dir_all(&path).unwrap();
        #[cfg(not(target_os = "macos"))]
        std::fs::write(&path, []).unwrap();
        let value = path.to_str().unwrap();
        let behavior: NativeBehavior =
            serde_json::from_value(serde_json::json!({"type":"openApp", "path":value})).unwrap();
        execute_with(&behavior, |target, application| {
            assert_eq!(target, value);
            assert!(application);
            Ok(())
        })
        .unwrap();
        for value in ["relative.exe", "https://example.com/app.exe", "", "\0"] {
            assert!(application_target(value).is_err());
        }
        let text = directory.join("Test.txt");
        std::fs::write(&text, []).unwrap();
        assert!(application_target(text.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(directory).unwrap();
        assert!(application_target(value).is_err());
    }

    #[test]
    fn commands_validate_text_and_existing_working_directory_and_skip_when_disabled() {
        let directory = std::env::temp_dir().join(format!("axonkey-cmd-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let dir_str = directory.to_str().unwrap().to_owned();

        EXECUTED_COMMANDS.with(|cmds| cmds.borrow_mut().clear());
        let behavior: NativeBehavior = serde_json::from_value(serde_json::json!({
            "type": "runCommand",
            "command": "  echo hello  ",
            "workingDirectory": dir_str
        }))
        .unwrap();
        execute(&behavior);
        EXECUTED_COMMANDS.with(|cmds| {
            assert_eq!(
                cmds.borrow().as_slice(),
                &[("echo hello".to_owned(), Some(dir_str.clone()))]
            );
        });

        let disabled = NativeBehavior::RunCommand {
            enabled: false,
            command: "echo never".into(),
            working_directory: None,
            title: None,
        };
        execute(&disabled);
        EXECUTED_COMMANDS.with(|cmds| assert_eq!(cmds.borrow().len(), 1));

        for (cmd, cwd) in [
            ("   ", None),
            ("echo\0bad", None),
            (&"a".repeat(MAX_COMMAND_CHARS + 1), None),
            ("echo ok", Some("relative/dir")),
            ("echo ok", Some("/definitely/missing/dir/axonkey-test")),
        ] {
            assert!(command_target(cmd, cwd).is_err(), "{cmd:?} {cwd:?}");
        }

        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn http_requests_validate_method_url_headers_body_and_dispatch_when_enabled() {
        SENT_HTTP_REQUESTS.with(|reqs| reqs.borrow_mut().clear());
        let behavior: NativeBehavior = serde_json::from_value(serde_json::json!({
            "type": "httpRequest",
            "method": "post",
            "url": "http://127.0.0.1:8123/api/webhook",
            "headers": {
                "Content-Type": "application/json",
                "X-Token": " secret "
            },
            "body": "{\"trigger\":true}"
        }))
        .unwrap();
        execute(&behavior);
        SENT_HTTP_REQUESTS.with(|reqs| {
            let borrowed = reqs.borrow();
            assert_eq!(borrowed.len(), 1);
            assert_eq!(borrowed[0].0, "POST");
            assert_eq!(borrowed[0].1, "http://127.0.0.1:8123/api/webhook");
            assert_eq!(
                borrowed[0].2.get("Content-Type").map(String::as_str),
                Some("application/json")
            );
            assert_eq!(
                borrowed[0].2.get("X-Token").map(String::as_str),
                Some("secret")
            );
            assert_eq!(borrowed[0].3.as_deref(), Some("{\"trigger\":true}"));
        });

        let disabled = NativeBehavior::HttpRequest {
            enabled: false,
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: None,
            body: None,
            title: None,
        };
        execute(&disabled);
        SENT_HTTP_REQUESTS.with(|reqs| assert_eq!(reqs.borrow().len(), 1));

        assert!(http_request_target("TRACE", "https://example.com", None, None).is_err());
        assert!(http_request_target("GET", "file:///etc/passwd", None, None).is_err());
        let mut dup = BTreeMap::new();
        dup.insert("X-Key".into(), "1".into());
        dup.insert("x-key".into(), "2".into());
        assert!(http_request_target("GET", "https://example.com", Some(&dup), None).is_err());
        let oversized_body = "x".repeat(MAX_HTTP_BODY_CHARS + 1);
        assert!(
            http_request_target("POST", "https://example.com", None, Some(&oversized_body))
                .is_err()
        );
    }
}
