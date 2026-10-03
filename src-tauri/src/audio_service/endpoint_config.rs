//! Persist an explicit Windows audio endpoint binding without risking the last good copy.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::endpoint_selection::EndpointBinding;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Read a binding without repairing, deleting, or overwriting an invalid file.
pub fn load(path: &Path) -> Result<Option<EndpointBinding>, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取音频端点配置：{error}")),
    };
    let binding: EndpointBinding = serde_json::from_slice(&contents)
        .map_err(|error| format!("音频端点配置格式无效，原文件已保留：{error}"))?;
    validate(&binding)?;
    Ok(Some(binding))
}

/// Persist a validated binding, including an explicit repair of invalid old data.
/// The caller must not automatically save after `load` reports an error.
pub fn save(path: &Path, binding: &EndpointBinding) -> Result<(), String> {
    save_with_replace(path, binding, replace_file)
}

/// Remove only the specified binding; a missing binding is already cleared.
pub fn clear(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除音频端点配置：{error}")),
    }
}

fn validate(binding: &EndpointBinding) -> Result<(), String> {
    if binding.schema_version != 1 {
        return Err(format!(
            "不支持音频端点配置版本 {}，原文件已保留",
            binding.schema_version
        ));
    }
    if binding.render_endpoint_id.trim().is_empty() {
        return Err("音频端点配置缺少播放端点 ID，原文件已保留".into());
    }
    if binding.adapter_instance_id.trim().is_empty() {
        return Err("音频端点配置缺少适配器实例 ID，原文件已保留".into());
    }
    if binding
        .capture_endpoint_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err("音频端点配置的录音端点 ID 为空，原文件已保留".into());
    }
    Ok(())
}

fn save_with_replace(
    path: &Path,
    binding: &EndpointBinding,
    replace: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> Result<(), String> {
    validate(binding)?;
    let contents = serde_json::to_vec_pretty(binding)
        .map_err(|error| format!("无法编码音频端点配置：{error}"))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| format!("无法创建音频配置目录：{error}"))?;

    let (mut file, mut temporary) = create_temporary_file(path)
        .map_err(|error| format!("无法创建音频端点配置临时文件：{error}"))?;
    let write_result = file
        .write_all(&contents)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all());
    // Windows cannot rename an open file unless it was opened with compatible sharing.
    drop(file);
    write_result.map_err(|error| format!("无法写入音频端点配置，原文件已保留：{error}"))?;
    replace(&temporary.path, path)
        .map_err(|error| format!("无法替换音频端点配置，原文件已保留：{error}"))?;
    temporary.committed = true;
    Ok(())
}

struct TemporaryFile {
    path: PathBuf,
    committed: bool,
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn create_temporary_file(path: &Path) -> io::Result<(File, TemporaryFile)> {
    let file_name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "配置路径必须包含文件名"))?;
    for _ in 0..16 {
        let mut temporary_name = file_name.to_os_string();
        temporary_name.push(format!(".{}.tmp", unique_suffix()));
        let temporary_path = path.with_file_name(temporary_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => {
                return Ok((
                    file,
                    TemporaryFile {
                        path: temporary_path,
                        committed: false,
                    },
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法创建唯一的音频配置临时文件",
    ))
}

fn unique_suffix() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{}-{timestamp}-{sequence}", std::process::id())
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Both paths are siblings, so this does not fall back to a cross-volume copy.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| io::Error::other(error.to_string()))
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("axonkey-endpoint-config-test-{}", unique_suffix()));
            // create_dir (not create_dir_all) ensures we own a newly-created directory.
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn binding_path(&self) -> PathBuf {
            self.0.join("audio-endpoint.json")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("axonkey-endpoint-config-test-"));
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn binding() -> EndpointBinding {
        EndpointBinding {
            schema_version: 1,
            render_endpoint_id: "{0.0.0.00000000}.{render}".into(),
            capture_endpoint_id: Some("{0.0.1.00000000}.{capture}".into()),
            adapter_instance_id: "ROOT\\MEDIA\\0001".into(),
        }
    }

    #[test]
    fn missing_binding_is_not_an_error() {
        let directory = TestDirectory::new();
        assert_eq!(load(&directory.binding_path()).unwrap(), None);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    }

    #[test]
    fn round_trip_creates_parents_and_uses_camel_case_fields() {
        let directory = TestDirectory::new();
        let path = directory.0.join("nested").join("audio-endpoint.json");
        let expected = binding();
        save(&path, &expected).unwrap();
        assert_eq!(load(&path).unwrap(), Some(expected));
        let serialized = fs::read_to_string(path).unwrap();
        assert!(serialized.contains("\"renderEndpointId\""));
        assert!(serialized.contains("\"schemaVersion\""));
    }

    #[test]
    fn replacement_persists_new_binding_and_removes_temporary_file() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        save(&path, &binding()).unwrap();
        let mut updated = binding();
        updated.render_endpoint_id = "replacement-endpoint".into();
        updated.capture_endpoint_id = None;
        save(&path, &updated).unwrap();
        assert_eq!(load(&path).unwrap(), Some(updated));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn loading_malformed_file_reports_error_without_writing_back() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        let corrupt = b"{\"schemaVersion\": 1, incomplete";
        fs::write(&path, corrupt).unwrap();
        assert!(load(&path).unwrap_err().contains("格式无效"));
        assert_eq!(fs::read(&path).unwrap(), corrupt);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn unsupported_version_is_reported_and_preserved() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        let mut future = binding();
        future.schema_version = 2;
        let contents = serde_json::to_vec(&future).unwrap();
        fs::write(&path, &contents).unwrap();
        assert!(load(&path).unwrap_err().contains("版本 2"));
        assert_eq!(fs::read(&path).unwrap(), contents);
    }

    #[test]
    fn explicit_save_can_repair_an_invalid_binding() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        fs::write(&path, b"invalid old configuration").unwrap();
        assert!(load(&path).is_err());
        save(&path, &binding()).unwrap();
        assert_eq!(load(&path).unwrap(), Some(binding()));
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn blank_required_identity_fields_are_rejected() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        let mut blank_render = binding();
        blank_render.render_endpoint_id = " \t".into();
        let mut blank_adapter = binding();
        blank_adapter.adapter_instance_id.clear();
        let mut blank_capture = binding();
        blank_capture.capture_endpoint_id = Some(" ".into());
        for invalid in [blank_render, blank_adapter, blank_capture] {
            assert!(save(&path, &invalid).is_err());
            assert!(!path.exists());
            fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(load(&path).is_err());
            clear(&path).unwrap();
        }
    }

    #[test]
    fn failed_replacement_preserves_old_file_and_cleans_up_only_its_temporary_file() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        let neighbour = directory.0.join("other-task.tmp");
        fs::write(&neighbour, b"unrelated temporary data").unwrap();
        save(&path, &binding()).unwrap();
        let original_bytes = fs::read(&path).unwrap();
        let mut updated = binding();
        updated.render_endpoint_id = "new-endpoint".into();

        let error = save_with_replace(&path, &updated, |temporary, destination| {
            assert_eq!(destination, path);
            assert_eq!(load(temporary).unwrap(), Some(updated.clone()));
            assert_eq!(fs::read(destination).unwrap(), original_bytes);
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "file locked",
            ))
        })
        .unwrap_err();

        assert!(error.contains("原文件已保留"));
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
        assert_eq!(fs::read(&neighbour).unwrap(), b"unrelated temporary data");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
    }

    #[test]
    fn invalid_new_binding_does_not_modify_last_good_file() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        save(&path, &binding()).unwrap();
        let original_bytes = fs::read(&path).unwrap();
        let mut invalid = binding();
        invalid.adapter_instance_id.clear();
        assert!(save(&path, &invalid).is_err());
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    }

    #[test]
    fn clear_is_idempotent_and_keeps_neighbours() {
        let directory = TestDirectory::new();
        let path = directory.binding_path();
        let neighbour = directory.0.join("settings.json");
        fs::write(&neighbour, b"unrelated settings").unwrap();
        save(&path, &binding()).unwrap();
        clear(&path).unwrap();
        clear(&path).unwrap();
        assert_eq!(load(&path).unwrap(), None);
        assert_eq!(fs::read(&neighbour).unwrap(), b"unrelated settings");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }
}
