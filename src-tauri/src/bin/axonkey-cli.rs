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
                println!(
                    "{}",
                    serde_json::json!({
                        "protocol": SCHEMA,
                        "ok": false,
                        "error": {
                            "code": exit_code_name(error.exit_code),
                            "message": error.message,
                        }
                    })
                );
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
}

impl CliFailure {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 2,
        }
    }
    fn runtime(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 3,
        }
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
    if command != "shortcut" && command != "mapping" && command != "profile" && command != "keymap"
    {
        return Err(CliFailure::usage(format!(
            "未知命令“{command}”，可用命令：capabilities、keymap、shortcut、mapping、profile"
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
            "profile" | "device" | "button" | "trigger" | "keys" | "sequence" | "actions"
            | "action" | "file" => name,
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
        r#"Axonkey Agent CLI

用法：
  axonkey-cli capabilities
  axonkey-cli status --json
  axonkey-cli keymap get --device <id> --json
  axonkey-cli shortcut <list|get|set|clear> [参数]
  axonkey-cli mapping <list|get|set|clear> [参数]
  axonkey-cli profile list --device <id>

常用参数：
  --device <id> --profile <id> --button <id> --trigger <click|doubleClick|longPress>
  --keys <Mod+Shift+P>       设置快捷键
  --sequence <json>          设置完整行为序列
  --actions <json>           --sequence 的别名；行为格式见 capabilities
  --dry-run                  只返回变更预览
  --yes                      确认清除操作

Mod 在 Windows 上表示 Ctrl，在 macOS 上表示 Cmd。"#
    );
}
