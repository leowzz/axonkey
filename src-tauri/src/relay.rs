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
        .inspect_err(|error| log::error!(target: "axonkey::relay", "session.load failed: {error}"))
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
    fs::create_dir_all(&directory).map_err(|error| {
        log::error!(target: "axonkey::relay", "session.directory failed kind={:?}", error.kind());
        "无法创建软件数据目录"
    })?;
    write_session(&directory.join("relay-session.json"), session)
        .inspect_err(|error| log::error!(target: "axonkey::relay", "session.save failed: {error}"))
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
    etag: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

#[tauri::command]
pub(crate) async fn relay_request(
    app: tauri::AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
    token: Option<String>,
    user_agent: String,
    if_match: Option<String>,
    if_none_match: Option<String>,
) -> Result<RelayResponse, String> {
    validate_request(&method, &path)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(
            if path == "/v2/behavior-library/usage" {
                3
            } else {
                20
            },
        ))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(user_agent)
        .build()
        .map_err(|_| {
            log::error!(target: "axonkey::relay", "request.client failed");
            "无法初始化云端连接"
        })?;
    let mut request = client
        .request(
            method.parse().map_err(|_| "不支持的请求方法")?,
            format!("https://relay.wleo.cn/api{path}"),
        )
        .header("X-App-Id", "axonkey")
        .header("X-App-Version", app.package_info().version.to_string());
    if let Some(value) = if_match {
        request = request.header("If-Match", value);
    }
    if let Some(value) = if_none_match {
        request = request.header("If-None-Match", value);
    }
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| {
            log::error!(target: "axonkey::relay", "request.send failed method={method} path={path} timeout={} connect={} request={}", error.is_timeout(), error.is_connect(), error.is_request());
            "无法连接云端，请检查网络后重试；本地功能不受影响"
        })?;
    let status = response.status().as_u16();
    let etag = response
        .headers()
        .get("ETag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let request_id = response
        .headers()
        .get("X-Request-ID")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = if status == 204 {
        Value::Null
    } else {
        response
            .json::<Value>()
            .await
            .map_err(|error| {
                log::error!(target: "axonkey::relay", "request.decode failed method={method} path={path} status={status} request_id={request_id:?} timeout={} decode={}", error.is_timeout(), error.is_decode());
                "云端响应无法读取，请稍后重试"
            })?
    };
    Ok(RelayResponse {
        status,
        body,
        request_id,
        etag,
    })
}

fn validate_request(method: &str, path: &str) -> Result<(), String> {
    if valid_library_request(method, path) {
        return Ok(());
    }
    let resource_id = path
        .strip_prefix("/v2/device-configs/")
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'));
    let list = path
        .strip_prefix("/v2/device-configs?app_id=axonkey&view=full&limit=100&offset=")
        .is_some_and(|offset| !offset.is_empty() && offset.bytes().all(|c| c.is_ascii_digit()));
    if (method == "GET"
        && (resource_id
            || list
            || matches!(
                path,
                "/v2/device-models?app_id=axonkey" | "/v2/app-settings/axonkey" | "/v2/me"
            )))
        || (method == "POST" && path == "/v2/device-configs")
        || (method == "PUT" && (resource_id || path == "/v2/app-settings/axonkey"))
    {
        return Ok(());
    }
    let allowed = match method {
        "POST" => matches!(
            path,
            "/auth/code"
                | "/auth/verify"
                | "/auth/v2/code"
                | "/auth/v2/verify"
                | "/auth/refresh"
                | "/auth/logout"
                | "/auth/console-ticket"
                | "/device-configs"
        ),
        "GET" => matches!(
            path,
            "/auth/captcha"
                | "/device-models?app_id=axonkey"
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

fn valid_library_request(method: &str, path: &str) -> bool {
    let (route, _) = path.split_once('?').unwrap_or((path, ""));
    let Some(tail) = route.strip_prefix("/v2/behavior-library") else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(&format!("https://relay.wleo.cn{path}")) else {
        return false;
    };
    if url.fragment().is_some() {
        return false;
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let value = |key: &str| {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_ref())
    };
    let only = |keys: &[&str]| {
        pairs.iter().all(|(key, _)| keys.contains(&key.as_ref()))
            && pairs.iter().enumerate().all(|(index, (key, _))| {
                !pairs[..index].iter().any(|(previous, _)| previous == key)
            })
    };
    let id =
        |part: &str| !part.is_empty() && part.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-');
    match (method, tail) {
        ("GET", "") => {
            only(&["app_id", "platform", "view", "limit", "q", "cursor"])
                && value("app_id") == Some("axonkey")
                && matches!(value("platform"), Some("windows" | "macos"))
                && matches!(value("view"), Some("recommended" | "community"))
        }
        ("GET", "/mine") => {
            only(&["app_id", "limit", "offset"]) && value("app_id") == Some("axonkey")
        }
        ("GET", "/admin/items") => {
            only(&["app_id", "limit", "offset"]) && value("app_id") == Some("axonkey")
        }
        ("POST", "/admin/recommendations") => pairs.is_empty(),
        ("POST", "/submissions" | "/usage") => pairs.is_empty(),
        ("POST", _) => {
            let parts: Vec<_> = tail.trim_start_matches('/').split('/').collect();
            match parts.as_slice() {
                [item, "additions"] => id(item) && pairs.is_empty(),
                ["mine", item, "withdraw" | "unpublish"] => {
                    id(item) && only(&["app_id"]) && value("app_id") == Some("axonkey")
                }
                ["admin", "items", item, "recommendation"] => id(item) && pairs.is_empty(),
                _ => false,
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn behavior_library_requests_use_the_app_routes_only() {
        for (method, path) in [
            ("GET", "/v2/me"),
            ("GET", "/v2/behavior-library/admin/items?app_id=axonkey&limit=100&offset=0"),
            ("POST", "/v2/behavior-library/admin/recommendations"),
            ("POST", "/v2/behavior-library/usage"),
            ("POST", "/v2/behavior-library/admin/items/019a-abcd/recommendation"),
            ("GET", "/v2/behavior-library?app_id=axonkey&platform=macos&view=recommended&limit=25"),
            ("GET", "/v2/behavior-library?app_id=axonkey&platform=windows&view=community&q=%E9%9F%B3%E9%87%8F&cursor=abc_123"),
            ("GET", "/v2/behavior-library/mine?app_id=axonkey&limit=100&offset=0"),
            ("POST", "/v2/behavior-library/submissions"),
            ("POST", "/v2/behavior-library/019a-abcd/additions"),
            ("POST", "/v2/behavior-library/mine/019a-abcd/withdraw?app_id=axonkey"),
            ("POST", "/v2/behavior-library/mine/019a-abcd/unpublish?app_id=axonkey"),
        ] {
            assert!(validate_request(method, path).is_ok(), "{method} {path}");
        }
        for (method, path) in [
            (
                "GET",
                "/v2/behavior-library?app_id=other&platform=macos&view=recommended",
            ),
            (
                "GET",
                "/v2/behavior-library?app_id=axonkey&app_id=other&platform=macos&view=recommended",
            ),
            (
                "GET",
                "/v2/behavior-library?app_id=axonkey&platform=macos&view=community#fragment",
            ),
            (
                "POST",
                "/v2/behavior-library/mine/../withdraw?app_id=axonkey",
            ),
            (
                "POST",
                "/v2/behavior-library/mine/019a-abcd/review?app_id=axonkey",
            ),
            ("GET", "/console/behavior-library/items?app_id=axonkey"),
            ("GET", "/v2/behavior-library/admin/items?app_id=other"),
            ("POST", "/v2/behavior-library/admin/items/019a-abcd/review"),
            ("DELETE", "/v2/behavior-library/019a-abcd"),
        ] {
            assert!(validate_request(method, path).is_err(), "{method} {path}");
        }
    }

    #[test]
    fn console_launch_accepts_only_url_safe_tickets() {
        let ticket = "a".repeat(43);
        assert_eq!(
            console_url(&ticket).unwrap(),
            format!("https://relay.wleo.cn/#console-ticket={ticket}")
        );
        for invalid in [
            "".to_owned(),
            "a".repeat(42),
            format!("{}&", "a".repeat(42)),
            "https://other.invalid".to_owned(),
        ] {
            assert!(console_url(&invalid).is_err());
        }
        assert!(validate_request("POST", "/auth/console-ticket").is_ok());
    }

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
    fn supports_v2_etag_resources_and_bounded_pagination_routes() {
        for (method, path) in [
            ("GET", "/v2/device-models?app_id=axonkey"),
            (
                "GET",
                "/v2/device-configs?app_id=axonkey&view=full&limit=100&offset=100",
            ),
            ("GET", "/v2/device-configs/019a-abcd"),
            ("POST", "/v2/device-configs"),
            ("PUT", "/v2/device-configs/019a-abcd"),
            ("PUT", "/v2/app-settings/axonkey"),
        ] {
            assert!(validate_request(method, path).is_ok(), "{method} {path}");
        }
        for path in [
            "/v2/device-configs/../me",
            "/v2/device-configs?app_id=axonkey&view=full&limit=100&offset=0&app_id=other",
            "/v2/console/device-configs",
        ] {
            assert!(validate_request("GET", path).is_err());
        }
        let response = RelayResponse {
            status: 200,
            body: Value::Null,
            request_id: None,
            etag: Some("\"opaque\"".into()),
        };
        assert_eq!(
            serde_json::to_value(response).unwrap()["etag"],
            "\"opaque\""
        );
    }

    #[test]
    fn only_supports_app_auth_and_config_routes() {
        assert!(validate_request("GET", "/auth/captcha").is_ok());
        assert!(validate_request("POST", "/auth/v2/code").is_ok());
        assert!(validate_request("POST", "/auth/v2/verify").is_ok());
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

// Only the fixed Relay origin and URL-safe ticket may reach the system browser launcher.
pub(crate) fn console_url(ticket: &str) -> Result<String, String> {
    if ticket.len() != 43
        || !ticket
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("控制台跳转凭据无效，请重试".into());
    }
    Ok(format!("https://relay.wleo.cn/#console-ticket={ticket}"))
}
