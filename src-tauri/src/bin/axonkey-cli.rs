//! External, non-GUI CLI for the Axonkey Agent protocol.
//!
//! The GUI owns the mapping state. This binary only creates a request file,
//! asks the installed app to process it, and waits for the response file.

use serde_json::{Map, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SCHEMA: &str = "axonkey.cli/v1";
const REQUEST_ARGUMENT: &str = "--cli-request";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let json_output = args.iter().any(|arg| arg == "--json");
    if args.iter().any(|arg| arg == "--help" || arg == "-h") || args.is_empty() {
        print_help();
        return;
    }
    match run(args) {
        Ok(output) => println!("{output}"),
        Err(error) => {
            if json_output {
                println!("{}", error.json_response());
            } else {
                eprintln!("axonkey: {}", error.message);
            }
            process::exit(error.exit_code);
        }
    }
}

fn exit_code_name(code: i32) -> &'static str {
    match code {
        2 => "invalid_arguments",
        3 => "app_unavailable",
        4 => "permission_denied",
        _ => "cli_error",
    }
}

#[derive(Debug)]
struct CliFailure {
    message: String,
    exit_code: i32,
    response: Option<Value>,
}

impl CliFailure {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 2,
            response: None,
        }
    }
    fn runtime(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 3,
            response: None,
        }
    }

    fn json_response(&self) -> Value {
        self.response.clone().unwrap_or_else(|| {
            serde_json::json!({
                "protocol": SCHEMA,
                "ok": false,
                "error": {
                    "code": exit_code_name(self.exit_code),
                    "message": self.message,
                }
            })
        })
    }
}

fn run(args: Vec<String>) -> Result<String, CliFailure> {
    let (operation, params) = parse_operation(&args)?;
    let id = request_id();
    let request = serde_json::json!({
        "protocol": SCHEMA,
        "id": id,
        "method": operation,
        "params": params,
    });
    let request_path = request_path(&id)?;
    write_json_atomically(&request_path, &request)?;
    launch_app(&request_path)?;
    let response_path = response_path(&id)?;
    let response = wait_for_response(&response_path)?;
    let _ = fs::remove_file(&request_path);
    let _ = fs::remove_file(&response_path);
    format_response(response)
}

fn parse_operation(args: &[String]) -> Result<(String, Value), CliFailure> {
    let command = args.first().map(String::as_str).unwrap_or_default();
    if command == "capabilities" {
        return Ok(("capabilities".into(), Value::Object(Map::new())));
    }
    if command == "status" {
        return Ok(("status".into(), Value::Object(Map::new())));
    }
    if !["shortcut", "mapping", "profile", "keymap", "device"].contains(&command) {
        return Err(CliFailure::usage(format!(
            "未知命令“{command}”，可用命令：capabilities、status、device、keymap、shortcut、mapping、profile"
        )));
    }
    let action = args
        .get(1)
        .ok_or_else(|| CliFailure::usage(format!("缺少 {command} 子命令")))?;
    let operation = format!("{command}.{action}");
    let mut params = Map::new();
    let mut index = 2;
    while index < args.len() {
        let flag = &args[index];
        if !flag.starts_with("--") {
            return Err(CliFailure::usage(format!("无法识别参数“{flag}”")));
        }
        let name = flag.trim_start_matches('-');
        if name == "yes" || name == "dry-run" || name == "json" {
            let key = if name == "dry-run" { "dryRun" } else { name };
            params.insert(key.into(), Value::Bool(true));
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| CliFailure::usage(format!("参数“{flag}”缺少值")))?;
        if value.starts_with("--") {
            return Err(CliFailure::usage(format!("参数“{flag}”缺少值")));
        }
        let key = match name {
            "profile" | "device" | "instance" | "name" | "button" | "input" | "trigger"
            | "keys" | "sequence" | "actions" | "action" | "file" => name,
            _ => return Err(CliFailure::usage(format!("无法识别参数“{flag}”"))),
        };
        let parsed = if key == "sequence" || key == "actions" || key == "action" {
            serde_json::from_str(value)
                .map_err(|error| CliFailure::usage(format!("--{key} 不是有效 JSON：{error}")))?
        } else {
            Value::String(value.clone())
        };
        params.insert(key.into(), parsed);
        index += 2;
    }
    Ok((operation, Value::Object(params)))
}

fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{}", process::id(), nanos)
}

fn app_config_dir() -> Result<PathBuf, CliFailure> {
    if let Some(path) = env::var_os("AXONKEY_CONFIG_DIR") {
        return Ok(PathBuf::from(path));
    }
    #[cfg(target_os = "windows")]
    {
        let base = env::var_os("APPDATA").or_else(|| env::var_os("LOCALAPPDATA"));
        base.map(|value| PathBuf::from(value).join("com.axonkey.app"))
            .ok_or_else(|| CliFailure::runtime("无法定位 Axonkey 配置目录"))
    }
    #[cfg(target_os = "macos")]
    {
        env::var_os("HOME")
            .map(|value| PathBuf::from(value).join("Library/Application Support/com.axonkey.app"))
            .ok_or_else(|| CliFailure::runtime("无法定位 Axonkey 配置目录"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        env::var_os("HOME")
            .map(|value| PathBuf::from(value).join(".config/com.axonkey.app"))
            .ok_or_else(|| CliFailure::runtime("无法定位 Axonkey 配置目录"))
    }
}

fn request_path(id: &str) -> Result<PathBuf, CliFailure> {
    let directory = app_config_dir()?.join("cli").join("requests");
    fs::create_dir_all(&directory)
        .map_err(|error| CliFailure::runtime(format!("无法创建 CLI 请求目录：{error}")))?;
    Ok(directory.join(format!("{id}.json")))
}

fn response_path(id: &str) -> Result<PathBuf, CliFailure> {
    let directory = app_config_dir()?.join("cli").join("responses");
    fs::create_dir_all(&directory)
        .map_err(|error| CliFailure::runtime(format!("无法创建 CLI 响应目录：{error}")))?;
    Ok(directory.join(format!("{id}.json")))
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<(), CliFailure> {
    let temporary = path.with_extension("tmp");
    let content = serde_json::to_vec(value)
        .map_err(|error| CliFailure::runtime(format!("无法编码 CLI 请求：{error}")))?;
    fs::write(&temporary, content)
        .map_err(|error| CliFailure::runtime(format!("无法写入 CLI 请求：{error}")))?;
    fs::rename(&temporary, path)
        .map_err(|error| CliFailure::runtime(format!("无法提交 CLI 请求：{error}")))
}

fn launch_app(request: &Path) -> Result<(), CliFailure> {
    let executable = env::var_os("AXONKEY_APP_EXECUTABLE")
        .map(PathBuf::from)
        .or_else(|| {
            let current = env::current_exe().ok()?;
            app_executable_for_cli(&current)
        })
        .ok_or_else(|| CliFailure::runtime("无法定位 Axonkey 主程序"))?;
    Command::new(&executable)
        .arg(REQUEST_ARGUMENT)
        .arg(request)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| CliFailure::runtime(format!("无法启动 Axonkey：{error}")))
}

fn app_executable_for_cli(cli_path: &Path) -> Option<PathBuf> {
    let current = fs::canonicalize(cli_path).ok()?;
    let executable_name = if cfg!(target_os = "windows") {
        "axonkey.exe"
    } else {
        "axonkey"
    };
    let app_bundle = current
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"));
    if let Some(bundle) = app_bundle {
        return Some(bundle.join("Contents/MacOS").join(executable_name));
    }
    let parent = current.parent()?;
    let sibling = parent.join(executable_name);
    if sibling.is_file() {
        return Some(sibling);
    }
    parent.parent().map(|root| root.join(executable_name))
}

fn wait_for_response(path: &Path) -> Result<Value, CliFailure> {
    let timeout = env::var("AXONKEY_CLI_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_TIMEOUT);
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if path.exists() {
            let content = fs::read_to_string(path)
                .map_err(|error| CliFailure::runtime(format!("无法读取 CLI 响应：{error}")))?;
            return serde_json::from_str(&content)
                .map_err(|error| CliFailure::runtime(format!("CLI 响应格式错误：{error}")));
        }
        if std::time::Instant::now() >= deadline {
            return Err(CliFailure::runtime(
                "等待 Axonkey 响应超时；请确认应用已启动且允许 CLI 控制",
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn format_response(response: Value) -> Result<String, CliFailure> {
    let ok = response.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let output = serde_json::to_string_pretty(&response)
        .map_err(|error| CliFailure::runtime(format!("无法格式化 CLI 响应：{error}")))?;
    if ok {
        Ok(output)
    } else {
        let code = response
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("cli_error");
        let message = response
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or(output.as_str())
            .to_string();
        Err(CliFailure {
            message,
            exit_code: response_code(code),
            response: Some(response),
        })
    }
}

fn response_code(code: &str) -> i32 {
    match code {
        "invalid_arguments" | "invalid_target" | "invalid_behavior" => 2,
        "permission_denied" => 4,
        "app_unavailable" => 3,
        _ => 5,
    }
}

fn print_help() {
    println!(
        "{}",
        r#"Axonkey Agent CLI

用法：
  axonkey-cli capabilities
  axonkey-cli status --json
  axonkey-cli device list --json
  axonkey-cli keymap get --device <id> --json
  axonkey-cli shortcut <list|get|set|clear> [参数]
  axonkey-cli mapping <list|get|set|clear> [参数]
  axonkey-cli profile list --instance <id>
  axonkey-cli profile create --instance <id> --name <名称>
  axonkey-cli profile activate --instance <id> --profile <配置 ID 或名称>

常用参数：
  --instance <id>            明确指定 device list 返回的设备实例
  --device <kind>            按型号选择唯一实例；同型号多台时使用 --instance
  --profile <id 或名称>      省略时使用设备当前激活配置
  --button <id>              按键；--input 为别名
  --trigger <click|doubleClick|longPress>
  --keys <Mod+Shift+P>       设置快捷键
  --sequence <json>          设置完整行为序列
  --actions <json>           --sequence 的别名；行为格式见 capabilities
  --dry-run                  只返回变更预览
  --yes                      确认清除操作

循环配置：
  mapping set --instance <id> --button <TV 按键 ID> \
    --sequence '[{"type":"switchProfile","direction":"next","wrap":true}]'
  此绑定应用于该设备所有配置，之后新建的配置也会继承。

Mod 在 Windows 上表示 Ctrl，在 macOS 上表示 Cmd。"#
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parses_device_and_profile_operations() {
        let (method, params) = parse_operation(&args(&["device", "list", "--json"])).unwrap();
        assert_eq!(method, "device.list");
        assert_eq!(params["json"], true);

        let (method, params) = parse_operation(&args(&[
            "profile",
            "create",
            "--instance",
            "remote-1",
            "--name",
            "鼠标操作",
            "--dry-run",
        ]))
        .unwrap();
        assert_eq!(method, "profile.create");
        assert_eq!(params["instance"], "remote-1");
        assert_eq!(params["name"], "鼠标操作");
        assert_eq!(params["dryRun"], true);

        let (method, params) = parse_operation(&args(&[
            "profile",
            "activate",
            "--device",
            "rc003",
            "--profile",
            "鼠标操作",
        ]))
        .unwrap();
        assert_eq!(method, "profile.activate");
        assert_eq!(params["device"], "rc003");
        assert_eq!(params["profile"], "鼠标操作");
    }

    #[test]
    fn parses_profile_cycle_sequence_and_input_alias() {
        let sequence = r#"[{"type":"switchProfile","direction":"next","wrap":true}]"#;
        let (method, params) = parse_operation(&args(&[
            "mapping",
            "set",
            "--instance",
            "remote-1",
            "--input",
            "tv",
            "--sequence",
            sequence,
        ]))
        .unwrap();
        assert_eq!(method, "mapping.set");
        assert_eq!(params["input"], "tv");
        assert_eq!(
            params["sequence"],
            serde_json::from_str::<Value>(sequence).unwrap()
        );
    }

    #[test]
    fn rejects_missing_option_value_and_invalid_sequence() {
        assert_eq!(
            parse_operation(&args(&["profile", "create", "--name", "--json"]))
                .unwrap_err()
                .exit_code,
            2
        );
        assert_eq!(
            parse_operation(&args(&["mapping", "set", "--sequence", "not-json"]))
                .unwrap_err()
                .exit_code,
            2
        );
    }

    #[test]
    fn preserves_app_error_envelope_and_exit_code() {
        let response = serde_json::json!({
            "protocol": SCHEMA,
            "id": "request-1",
            "ok": false,
            "error": {"code": "invalid_target", "message": "请指定实例", "instances": ["a", "b"]},
        });
        let error = format_response(response.clone()).unwrap_err();
        assert_eq!(error.exit_code, 2);
        assert_eq!(error.message, "请指定实例");
        assert_eq!(error.json_response(), response);
    }

    #[test]
    fn formats_local_error_and_success_response() {
        let error = CliFailure::runtime("无法启动应用");
        assert_eq!(error.json_response()["error"]["code"], "app_unavailable");
        let response =
            serde_json::json!({"protocol": SCHEMA, "ok": true, "result": {"revision": 2}});
        assert_eq!(
            serde_json::from_str::<Value>(&format_response(response.clone()).unwrap()).unwrap(),
            response
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_path_symlink_to_app_bundle_executable() {
        let root = env::temp_dir().join(format!("axonkey-cli-symlink-{}", request_id()));
        let macos = root.join("Axonkey.app/Contents/MacOS");
        let bin = root.join("bin");
        fs::create_dir_all(&macos).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let bundled_cli = macos.join("axonkey-cli");
        fs::write(&bundled_cli, b"").unwrap();
        let path_cli = bin.join("axonkey-cli");
        std::os::unix::fs::symlink(&bundled_cli, &path_cli).unwrap();
        let expected = fs::canonicalize(&macos).unwrap().join("axonkey");
        assert_eq!(app_executable_for_cli(&path_cli), Some(expected));
        fs::remove_dir_all(root).unwrap();
    }
}
