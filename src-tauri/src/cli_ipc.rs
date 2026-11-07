//! File-backed request/response bridge for the external Axonkey CLI.
//!
//! Mappings currently live in the WebView's localStorage, so the CLI hands
//! requests to the running application instead of writing browser storage.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const REQUEST_FLAG: &str = "--cli-request";
pub const CLI_PROTOCOL: &str = "axonkey.cli/v1";
const ROOT_DIR: &str = "cli";
const REQUESTS_DIR: &str = "requests";
const PROCESSING_DIR: &str = "processing";
const RESPONSES_DIR: &str = "responses";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRequest {
    pub protocol: String,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResponse {
    pub protocol: String,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CliError>,
}

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(ROOT_DIR))
        .map_err(|error| format!("Cannot resolve CLI data directory: {error}"))
}

fn ensure_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = root_dir(app)?;
    let requests = root.join(REQUESTS_DIR);
    let processing = root.join(PROCESSING_DIR);
    let responses = root.join(RESPONSES_DIR);
    for directory in [&requests, &processing, &responses] {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Cannot create CLI data directory: {error}"))?;
    }
    Ok((requests, processing, responses))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn json_path(directory: &Path, id: &str) -> PathBuf {
    directory.join(format!("{id}.json"))
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let _ = ensure_dirs(app)?;
    Ok(())
}

/// Atomically claims pending requests so a slow frontend cannot process one twice.
#[tauri::command]
pub fn cli_poll_requests(app: AppHandle) -> Result<Vec<CliRequest>, String> {
    let (requests, processing, _) = ensure_dirs(&app)?;
    let mut entries = fs::read_dir(&requests)
        .map_err(|error| format!("Cannot read CLI request directory: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    let mut result = Vec::new();
    for entry in entries {
        let source = entry.path();
        let Some(id) = source.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !valid_id(id) {
            continue;
        }
        let claimed = json_path(&processing, id);
        if fs::rename(&source, &claimed).is_err() {
            continue;
        }
        let parsed = fs::read_to_string(&claimed)
            .map_err(|error| format!("Cannot read CLI request: {error}"))
            .and_then(|text| {
                serde_json::from_str::<CliRequest>(&text)
                    .map_err(|error| format!("Cannot decode CLI request: {error}"))
            });
        match parsed {
            Ok(request) if request.id == id && request.protocol == CLI_PROTOCOL => {
                result.push(request)
            }
            Ok(_) | Err(_) => {
                let _ = fs::remove_file(&claimed);
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn cli_write_response(app: AppHandle, response: CliResponse) -> Result<(), String> {
    if !valid_id(&response.id) || response.protocol != CLI_PROTOCOL {
        return Err("Invalid CLI response".into());
    }
    let (_, processing, responses) = ensure_dirs(&app)?;
    let destination = json_path(&responses, &response.id);
    let temporary = responses.join(format!(".{}.tmp", response.id));
    let content = serde_json::to_vec(&response)
        .map_err(|error| format!("Cannot encode CLI response: {error}"))?;
    fs::write(&temporary, content)
        .map_err(|error| format!("Cannot write CLI response: {error}"))?;
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Cannot publish CLI response: {error}"))?;
    let _ = fs::remove_file(json_path(&processing, &response.id));
    Ok(())
}

#[tauri::command]
pub fn cli_cancel_request(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Invalid CLI request ID".into());
    }
    let (_, processing, _) = ensure_dirs(&app)?;
    let _ = fs::remove_file(json_path(&processing, &id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_id;

    #[test]
    fn request_ids_are_safe_filenames() {
        assert!(valid_id("request-2026-01"));
        assert!(!valid_id("../request"));
        assert!(!valid_id("request/child"));
        assert!(!valid_id(""));
    }
}
