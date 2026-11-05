use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::Duration;
use tauri::Manager;

#[tauri::command]
pub(crate) fn load_relay_session(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法读取软件数据目录")?;
    read_session(&directory.join("relay-session.json"))
}

#[tauri::command]
pub(crate) fn save_relay_session(
    app: tauri::AppHandle,
    session: Option<Value>,
) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法读取软件数据目录")?;
    fs::create_dir_all(&directory).map_err(|_| "无法创建软件数据目录")?;
    write_session(&directory.join("relay-session.json"), session)
}

fn read_session(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "登录凭据无法读取，请重新登录".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("无法读取登录凭据文件；本地功能不受影响".into()),
    }
}

fn write_session(path: &Path, session: Option<Value>) -> Result<(), String> {
    match session {
        Some(session) => {
            let temporary = path.with_extension("tmp");
            fs::write(&temporary, session.to_string()).map_err(|_| "无法保存登录凭据文件")?;
            fs::rename(&temporary, path).map_err(|_| "无法更新登录凭据文件".into())
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法清除登录凭据文件，请重试退出登录".into()),
        },
    }
}

#[derive(Serialize)]
pub(crate) struct RelayResponse {
    status: u16,
    body: Value,
}

#[tauri::command]
pub(crate) async fn relay_request(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
    token: Option<String>,
    user_agent: String,
) -> Result<RelayResponse, String> {
    validate_request(&method, &path)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(user_agent)
        .build()
        .map_err(|_| "无法初始化云端连接")?;
    let mut request = client
        .request(
            method.parse().map_err(|_| "不支持的请求方法")?,
            format!("https://relay.wleo.cn/api{path}"),
        )
        .header("X-App-Id", "axonkey")
        .header("X-App-Version", app.package_info().version.to_string());
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接云端，请检查网络后重试；本地功能不受影响")?;
    let status = response.status().as_u16();
    let body = if status == 204 {
        Value::Null
    } else {
        response
            .json::<Value>()
            .await
            .map_err(|_| "云端响应无法读取，请稍后重试")?
    };
    Ok(RelayResponse { status, body })
}

fn validate_request(method: &str, path: &str) -> Result<(), String> {
    let allowed = match method {
        "POST" => matches!(
            path,
            "/auth/code" | "/auth/verify" | "/auth/refresh" | "/auth/logout" | "/device-configs"
        ),
        "GET" => matches!(
            path,
            "/device-models?app_id=axonkey"
                | "/device-configs?app_id=axonkey"
                | "/app-settings/axonkey"
        ),
        "PUT" => {
            path == "/app-settings/axonkey"
                || path.strip_prefix("/device-configs/").is_some_and(|id| {
                    !id.is_empty() && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
                })
        }
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("不支持的云端请求".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_refresh_retries_replaces_credentials_and_removes_on_logout() {
        let directory =
            std::env::temp_dir().join(format!("axonkey-relay-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("relay-session.json");
        write_session(&path, None).unwrap();
        assert_eq!(read_session(&path).unwrap(), None);
        let pending =
            serde_json::json!({"refresh_token": "test-only-old", "requestId": "retry-id"});
        write_session(&path, Some(pending.clone())).unwrap();
        assert_eq!(read_session(&path).unwrap(), Some(pending));
        let rotated = serde_json::json!({"refresh_token": "test-only-new"});
        write_session(&path, Some(rotated.clone())).unwrap();
        assert_eq!(read_session(&path).unwrap(), Some(rotated));
        assert!(!path.with_extension("tmp").exists());
        write_session(&path, None).unwrap();
        assert_eq!(read_session(&path).unwrap(), None);
        fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn only_supports_app_auth_and_config_routes() {
        assert!(validate_request("POST", "/auth/refresh").is_ok());
        assert!(validate_request("PUT", "/device-configs/019a-abcd").is_ok());
        for path in [
            "//example.com",
            "/console/users",
            "/device-configs/../auth/logout",
            "/device-configs/a?x=1",
        ] {
            assert!(validate_request("PUT", path).is_err());
        }
    }
}
