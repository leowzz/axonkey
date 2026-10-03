use super::NativeBehavior;
use std::path::Path;

fn website_target(value: &str) -> Result<String, String> {
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

fn execute_with(
    behavior: &NativeBehavior,
    open: impl FnOnce(&str, bool) -> Result<(), String>,
) -> Result<(), String> {
    if !behavior.enabled() {
        return Ok(());
    }
    match behavior {
        NativeBehavior::OpenApp { path, .. } => open(&application_target(path)?, true),
        NativeBehavior::OpenWebsite { url, .. } => open(&website_target(url)?, false),
        _ => Ok(()),
    }
}

pub(super) fn execute(behavior: &NativeBehavior) {
    let kind = match behavior {
        NativeBehavior::OpenApp { .. } => "openApp",
        NativeBehavior::OpenWebsite { .. } => "openWebsite",
        _ => return,
    };
    match execute_with(behavior, open_target) {
        Ok(()) => log::info!(target: "axonkey::input", "Mapped launch: type={kind}, succeeded"),
        Err(error) => {
            log::warn!(target: "axonkey::input", "Mapped launch failed: type={kind}, error={error}")
        }
    }
}

#[cfg(target_os = "windows")]
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
        ) -> *mut c_void;
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
    } as isize;
    if result <= 32 {
        return Err(format!(
            "Windows could not open the target (ShellExecute error {result})"
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
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

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn open_target(_target: &str, _application: bool) -> Result<(), String> {
    Err("Launching targets is only supported on Windows and macOS".into())
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
}
