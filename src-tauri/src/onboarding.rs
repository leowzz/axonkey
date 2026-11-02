use std::path::Path;
use tauri::Manager;

#[derive(Default, serde::Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
struct OnboardingConfig {
    onboarding_completed: bool,
}

#[tauri::command]
pub(crate) fn get_onboarding_completed(app: tauri::AppHandle) -> Result<bool, String> {
    read_completed(&config_path(&app)?)
}

#[tauri::command]
pub(crate) fn complete_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    write_completed(&config_path(&app)?)
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("onboarding.json"))
        .map_err(|error| format!("无法定位使用指南配置：{error}"))
}

fn read_completed(path: &Path) -> Result<bool, String> {
    let contents = match std::fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法读取使用指南配置：{error}")),
    };
    serde_json::from_slice::<OnboardingConfig>(&contents)
        .map(|config| config.onboarding_completed)
        .map_err(|error| format!("无法解析使用指南配置：{error}"))
}

fn write_completed(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let config = OnboardingConfig {
        onboarding_completed: true,
    };
    let contents = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(path, contents).map_err(|error| format!("无法保存使用指南配置：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_round_trip_and_legacy_defaults() {
        let path = std::env::temp_dir()
            .join(format!("axonkey-onboarding-test-{}", std::process::id()))
            .join("onboarding.json");
        assert!(!read_completed(&path).unwrap());
        write_completed(&path).unwrap();
        assert!(read_completed(&path).unwrap());
        for contents in ["{}", r#"{"onboardingCompleted":false}"#] {
            std::fs::write(&path, contents).unwrap();
            assert!(!read_completed(&path).unwrap());
        }
        std::fs::write(&path, "invalid json").unwrap();
        assert!(read_completed(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(path.parent().unwrap()).unwrap();
    }
}
