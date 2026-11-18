use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CURRENT_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 512;
const MAX_KEY_BYTES: usize = 128;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PersistedAppConfig {
    version: u32,
    #[serde(default, deserialize_with = "deserialize_entries")]
    entries: BTreeMap<String, String>,
}

impl Default for PersistedAppConfig {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

fn deserialize_entries<'de, D>(deserializer: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = BTreeMap::<String, serde_json::Value>::deserialize(deserializer)?;
    let mut entries = BTreeMap::new();
    for (key, value) in raw {
        match value {
            serde_json::Value::String(text) => {
                entries.insert(key, text);
            }
            serde_json::Value::Number(num) => {
                entries.insert(key, num.to_string());
            }
            serde_json::Value::Bool(flag) => {
                entries.insert(key, flag.to_string());
            }
            serde_json::Value::Null => {}
            other => {
                // Keep structured JSON entries usable if hand-edited as raw objects/arrays.
                entries.insert(key, other.to_string());
            }
        }
    }
    Ok(entries)
}

enum LoadError {
    Io(String),
    Corrupt(String),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(msg) | Self::Corrupt(msg) => f.write_str(msg),
        }
    }
}

struct StoreState {
    entries: BTreeMap<String, String>,
    unrecovered_io_error: Option<String>,
}

pub(crate) struct AppConfigStore {
    path: PathBuf,
    state: Mutex<StoreState>,
}

impl AppConfigStore {
    pub(crate) fn open(path: PathBuf) -> Self {
        let state = match read_with_recovery(&path) {
            Ok(config) => StoreState {
                entries: config.entries,
                unrecovered_io_error: None,
            },
            Err(error) => {
                log::error!(
                    target: "axonkey::config",
                    "Failed to load {}: {error}",
                    path.display()
                );
                match error {
                    LoadError::Corrupt(_) => {
                        if path.exists() {
                            let corrupt = unique_corrupt_path(&path);
                            let _ = std::fs::rename(&path, &corrupt);
                        }
                        StoreState {
                            entries: BTreeMap::new(),
                            unrecovered_io_error: None,
                        }
                    }
                    LoadError::Io(msg) => StoreState {
                        entries: BTreeMap::new(),
                        unrecovered_io_error: Some(msg),
                    },
                }
            }
        };
        Self {
            path,
            state: Mutex::new(state),
        }
    }

    fn ensure_loaded<'a>(&'a self, guard: &mut StoreState) -> Result<(), String> {
        if guard.unrecovered_io_error.is_none() {
            return Ok(());
        }
        match read_with_recovery(&self.path) {
            Ok(config) => {
                guard.entries = config.entries;
                guard.unrecovered_io_error = None;
                Ok(())
            }
            Err(LoadError::Io(msg)) => {
                guard.unrecovered_io_error = Some(msg.clone());
                Err(format!("无法读取软件配置文件：{msg}"))
            }
            Err(LoadError::Corrupt(_)) => {
                if self.path.exists() {
                    let corrupt = unique_corrupt_path(&self.path);
                    let _ = std::fs::rename(&self.path, &corrupt);
                }
                guard.entries.clear();
                guard.unrecovered_io_error = None;
                Ok(())
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Result<BTreeMap<String, String>, String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "软件配置状态不可用".to_string())?;
        self.ensure_loaded(&mut guard)?;
        Ok(guard.entries.clone())
    }

    pub(crate) fn update(&self, updates: BTreeMap<String, Option<String>>) -> Result<(), String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "软件配置状态不可用".to_string())?;
        self.ensure_loaded(&mut guard)?;
        let mut next = guard.entries.clone();
        let mut changed = false;

        for (key, value) in updates {
            match value {
                Some(content) => {
                    validate_key(&key)?;
                    if next.get(&key) != Some(&content) {
                        next.insert(key, content);
                        changed = true;
                    }
                }
                None => {
                    if next.remove(&key).is_some() {
                        changed = true;
                    }
                }
            }
        }

        if !changed {
            return Ok(());
        }
        validate_entries(&next)?;
        write_atomic(
            &self.path,
            &PersistedAppConfig {
                version: CURRENT_VERSION,
                entries: next.clone(),
            },
        )?;
        guard.entries = next;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn load_app_config(
    state: tauri::State<'_, AppConfigStore>,
) -> Result<BTreeMap<String, String>, String> {
    state.snapshot()
}

#[tauri::command]
pub(crate) fn update_app_config(
    state: tauri::State<'_, AppConfigStore>,
    updates: BTreeMap<String, Option<String>>,
) -> Result<(), String> {
    state.update(updates)
}

fn validate_key(key: &str) -> Result<(), String> {
    if !key.starts_with("axonkey.") || key.len() > MAX_KEY_BYTES {
        return Err(format!("不支持的配置键：{key}"));
    }
    if key.contains(".cache.") || key.contains(".preview.") {
        return Err(format!("临时缓存或预览键不写入软件配置：{key}"));
    }
    Ok(())
}

fn validate_entries(entries: &BTreeMap<String, String>) -> Result<(), String> {
    if entries.len() > MAX_ENTRIES {
        return Err("配置项数量超过上限".into());
    }
    let total_bytes: usize = entries.iter().map(|(k, v)| k.len() + v.len()).sum();
    if total_bytes > MAX_TOTAL_BYTES {
        return Err("配置内容大小超过上限".into());
    }
    Ok(())
}

fn unique_corrupt_path(path: &Path) -> PathBuf {
    let default = path.with_extension("corrupt.json");
    if !default.exists() {
        return default;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    path.with_extension(format!("corrupt-{stamp}.json"))
}

fn read_with_recovery(path: &Path) -> Result<PersistedAppConfig, LoadError> {
    let backup = path.with_extension("bak");
    if path.exists() {
        match read_config_file(path) {
            Ok(config) => return Ok(config),
            Err(primary_error) if backup.exists() => {
                log::warn!(
                    target: "axonkey::config",
                    "Primary app-config unreadable ({primary_error}), attempting backup {}",
                    backup.display()
                );
                return read_config_file(&backup);
            }
            Err(primary_error) => return Err(primary_error),
        }
    }
    if backup.exists() {
        return read_config_file(&backup);
    }
    Ok(PersistedAppConfig::default())
}

fn read_config_file(path: &Path) -> Result<PersistedAppConfig, LoadError> {
    let bytes = std::fs::read(path).map_err(|e| LoadError::Io(e.to_string()))?;
    let parsed: PersistedAppConfig = serde_json::from_slice(&bytes)
        .map_err(|e| LoadError::Corrupt(format!("无法解析配置文件：{e}")))?;
    if parsed.version == 0 {
        return Err(LoadError::Corrupt("不支持的配置文件版本：0".into()));
    }
    if parsed.version > CURRENT_VERSION {
        log::warn!(
            target: "axonkey::config",
            "Loading forward-version app-config v{} with compatible entries map",
            parsed.version
        );
    }
    Ok(parsed)
}

fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last_err = None;
    for attempt in 0..3 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
            }
        }
    }
    Err(last_err.unwrap())
}

fn write_atomic(path: &Path, config: &PersistedAppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建软件数据目录：{e}"))?;
    }
    let temp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| format!("无法写入软件配置文件：{e}"))?;
    let payload = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    file.write_all(&payload)
        .map_err(|e| format!("无法写入软件配置文件：{e}"))?;
    file.sync_all()
        .map_err(|e| format!("无法刷写软件配置文件：{e}"))?;
    drop(file);

    if path.exists() {
        if backup.exists() {
            let _ = std::fs::remove_file(&backup);
        }
        rename_with_retry(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = rename_with_retry(&temp, path) {
        let _ = rename_with_retry(&backup, path);
        return Err(format!("无法更新软件配置文件：{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "axonkey-app-storage-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("app-config.json")
    }

    #[test]
    fn persists_updates_and_deletions_across_reopen() {
        let path = temp_config_path("roundtrip");
        let store = AppConfigStore::open(path.clone());
        assert!(store.snapshot().unwrap().is_empty());

        store
            .update(BTreeMap::from([
                (
                    "axonkey.settings.v1".into(),
                    Some("{\"enabled\":true}".into()),
                ),
                (
                    "axonkey.mapping-profiles.v2".into(),
                    Some("{\"version\":2}".into()),
                ),
            ]))
            .unwrap();

        let reopened = AppConfigStore::open(path.clone());
        assert_eq!(
            reopened.snapshot().unwrap().get("axonkey.settings.v1"),
            Some(&"{\"enabled\":true}".to_string())
        );

        reopened
            .update(BTreeMap::from([("axonkey.settings.v1".into(), None)]))
            .unwrap();
        let after_delete = AppConfigStore::open(path.clone());
        assert!(!after_delete
            .snapshot()
            .unwrap()
            .contains_key("axonkey.settings.v1"));
        assert!(after_delete
            .snapshot()
            .unwrap()
            .contains_key("axonkey.mapping-profiles.v2"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn recovers_from_backup_when_primary_file_is_missing_or_corrupt() {
        let path = temp_config_path("recovery");
        let backup = path.with_extension("bak");
        write_atomic(
            &backup,
            &PersistedAppConfig {
                version: CURRENT_VERSION,
                entries: BTreeMap::from([(
                    "axonkey.audio-settings.v2".into(),
                    "{\"gain\":12}".into(),
                )]),
            },
        )
        .unwrap();

        let from_missing = AppConfigStore::open(path.clone());
        assert_eq!(
            from_missing
                .snapshot()
                .unwrap()
                .get("axonkey.audio-settings.v2"),
            Some(&"{\"gain\":12}".to_string())
        );

        std::fs::write(&path, b"{not-json").unwrap();
        let from_corrupt = AppConfigStore::open(path.clone());
        assert_eq!(
            from_corrupt
                .snapshot()
                .unwrap()
                .get("axonkey.audio-settings.v2"),
            Some(&"{\"gain\":12}".to_string())
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn tolerates_non_string_json_entries_and_large_multibyte_payloads() {
        let path = temp_config_path("tolerant-large");
        std::fs::write(
            &path,
            br#"{"version":1,"entries":{"axonkey.settings.v1":{"enabled":true},"axonkey.remote-interaction-hint.v1":1,"axonkey.ui-state.v1":null}}"#,
        )
        .unwrap();

        let store = AppConfigStore::open(path.clone());
        let snapshot = store.snapshot().unwrap();
        assert_eq!(
            snapshot.get("axonkey.settings.v1"),
            Some(&"{\"enabled\":true}".to_string())
        );
        assert_eq!(
            snapshot.get("axonkey.remote-interaction-hint.v1"),
            Some(&"1".to_string())
        );
        assert!(!snapshot.contains_key("axonkey.ui-state.v1"));

        // 6 MB UTF-8 payload (equivalent to ~2M Chinese characters in WebView localStorage) succeeds cleanly.
        let large_sequences = "中".repeat(2_000_000);
        store
            .update(BTreeMap::from([(
                "axonkey.saved-sequences.v1".into(),
                Some(large_sequences.clone()),
            )]))
            .unwrap();
        let reopened = AppConfigStore::open(path.clone());
        assert_eq!(
            reopened
                .snapshot()
                .unwrap()
                .get("axonkey.saved-sequences.v1")
                .map(String::len),
            Some(large_sequences.len())
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn preserves_forward_version_entries_and_blocks_overwrite_during_transient_io_failure() {
        let path = temp_config_path("forward-and-io");
        std::fs::write(
            &path,
            br#"{"version":2,"entries":{"axonkey.mapping-profiles.v2":"{\"version\":2}"},"extraFutureField":true}"#,
        )
        .unwrap();

        let forward_store = AppConfigStore::open(path.clone());
        assert_eq!(
            forward_store
                .snapshot()
                .unwrap()
                .get("axonkey.mapping-profiles.v2"),
            Some(&"{\"version\":2}".to_string())
        );

        // Simulate an unreadable directory occupying `path` (Io error, not Corrupt JSON):
        // snapshot() and update() must return Err rather than clobbering or returning empty defaults.
        let io_dir = temp_config_path("io-blocked");
        std::fs::create_dir_all(&io_dir).unwrap();
        let io_store = AppConfigStore::open(io_dir.clone());
        assert!(io_store.snapshot().is_err());
        assert!(io_store
            .update(BTreeMap::from([(
                "axonkey.settings.v1".into(),
                Some("{}".into())
            )]))
            .is_err());
        assert!(io_dir.is_dir());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        let _ = std::fs::remove_dir_all(io_dir.parent().unwrap());
    }

    #[test]
    fn rejects_cache_preview_and_foreign_keys() {
        let path = temp_config_path("validation");
        let store = AppConfigStore::open(path.clone());
        for invalid in [
            "other.key",
            "axonkey.device-model-catalog.cache.v2",
            "axonkey.device-instances.preview.v1",
        ] {
            assert!(store
                .update(BTreeMap::from([(invalid.into(), Some("1".into()))]))
                .is_err());
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
