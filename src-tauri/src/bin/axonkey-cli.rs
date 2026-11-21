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
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        if json_output {
            if let Ok(output) = wrap_cli_ok(serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": SCHEMA,
            })) {
                println!("{output}");
                return;
            }
        }
        println!("axonkey-cli {}", env!("CARGO_PKG_VERSION"));
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
    fn uac_cancelled(
        message: impl Into<String>,
        instance_id: &str,
        bound_to_quarbor: bool,
    ) -> Self {
        let message = message.into();
        let response = serde_json::json!({
            "protocol": SCHEMA,
            "ok": false,
            "error": {
                "code": exit_code_name(4),
                "message": message,
                "cancelledByUser": true,
                "instanceId": instance_id,
                "boundToQuarbor": bound_to_quarbor,
            }
        });
        Self {
            message,
            exit_code: 4,
            response: Some(response),
        }
    }
    fn execution(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 5,
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
    if args.first().map(String::as_str) == Some("capture") {
        return run_capture_command(&args);
    }
    let (operation, params) = parse_operation(&args)?;
    let id = request_id();
    let request = serde_json::json!({
        "protocol": SCHEMA,
        "id": id,
        "method": operation,
        "params": params,
    });
    let request_path = request_path(&id)?;
    let response_path = response_path(&id)?;
    write_json_atomically(&request_path, &request)?;
    let result = (|| {
        launch_app(&request_path)?;
        format_response(wait_for_response(&response_path)?)
    })();
    let _ = fs::remove_file(&request_path);
    let _ = fs::remove_file(&response_path);
    result
}

fn parse_operation(args: &[String]) -> Result<(String, Value), CliFailure> {
    let command = args.first().map(String::as_str).unwrap_or_default();
    let standalone = command == "capabilities" || command == "status";
    if !standalone
        && ![
            "shortcut", "mapping", "profile", "preset", "keymap", "device",
        ]
        .contains(&command)
    {
        return Err(CliFailure::usage(format!(
            "未知命令“{command}”，可用命令：capabilities、status、device、preset、keymap、shortcut、mapping、profile、capture"
        )));
    }
    let action = if standalone {
        ""
    } else {
        args.get(1)
            .ok_or_else(|| CliFailure::usage(format!("缺少 {command} 子命令")))?
            .as_str()
    };
    let valid_action = match command {
        "shortcut" | "mapping" => ["list", "get", "set", "clear"].contains(&action),
        "profile" => [
            "list",
            "create",
            "activate",
            "rename",
            "duplicate",
            "delete",
            "prompt-mode",
            "application-list",
            "application-set",
            "application-remove",
            "application-toggle",
        ]
        .contains(&action),
        "preset" => ["list", "apply"].contains(&action),
        "keymap" => action == "get",
        "device" => ["list", "toggle"].contains(&action),
        _ => standalone,
    };
    if !valid_action {
        return Err(CliFailure::usage(format!(
            "不支持的子命令：{command} {action}"
        )));
    }
    let operation = if standalone {
        command.into()
    } else {
        format!("{command}.{action}")
    };
    let mut params = Map::new();
    let mut index = if standalone { 1 } else { 2 };
    while index < args.len() {
        let flag = &args[index];
        if !flag.starts_with("--") {
            return Err(CliFailure::usage(format!("无法识别参数“{flag}”")));
        }
        let name = flag.trim_start_matches('-');
        if standalone && name != "json" {
            return Err(CliFailure::usage(format!("{command} 不支持参数“{flag}”")));
        }
        if matches!(
            name,
            "yes" | "dry-run" | "json" | "on" | "off" | "quick" | "prompt-mode"
        ) {
            if name == "on" || name == "off" {
                if params.contains_key("enabled") {
                    return Err(CliFailure::usage("--on 和 --off 不能重复或同时使用"));
                }
                params.insert("enabled".into(), Value::Bool(name == "on"));
                index += 1;
                continue;
            }
            let key = match name {
                "dry-run" => "dryRun",
                "prompt-mode" => "promptMode",
                _ => name,
            };
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
            | "keys" | "sequence" | "actions" | "action" | "file" | "preset" | "mode"
            | "application" | "application-name" | "application-path" => match name {
                "application-name" => "applicationName",
                "application-path" => "applicationPath",
                _ => name,
            },
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
    if response.get("protocol").and_then(Value::as_str) != Some(SCHEMA) {
        return Err(CliFailure::runtime("CLI 响应协议无效"));
    }
    let ok = response
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| CliFailure::runtime("CLI 响应缺少有效的 ok 字段"))?;
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
  axonkey-cli --version [--json]
  axonkey-cli capabilities [--json]
  axonkey-cli status --json
  axonkey-cli device list --json
  axonkey-cli device toggle --instance <id> --on|--off [--dry-run] [--json]
  axonkey-cli preset list --device <kind>|--instance <id> --json
  axonkey-cli preset apply --instance <id> --preset <slug> [--mode copy|overwrite] [--profile <id 或名称>] [--name <新名称>] [--dry-run] [--json]
  axonkey-cli keymap get --device <id> --json
  axonkey-cli shortcut <list|get|set|clear> [参数]
  axonkey-cli mapping <list|get|set|clear> [参数]
  axonkey-cli profile list --instance <id>
  axonkey-cli profile create --instance <id> --name <名称> [--quick] [--prompt-mode] [--dry-run]
  axonkey-cli profile activate --instance <id> --profile <配置 ID 或名称>
  axonkey-cli profile rename --instance <id> --profile <配置 ID 或名称> --name <新名称> [--dry-run]
  axonkey-cli profile duplicate --instance <id> [--profile <源配置>] [--name <新名称>] [--quick] [--dry-run]
  axonkey-cli profile delete --instance <id> --profile <配置 ID 或名称> --yes [--dry-run]
  axonkey-cli profile prompt-mode --instance <id> --profile <快捷配置 ID 或名称> --on|--off [--dry-run]
  axonkey-cli profile application-list --instance <id>
  axonkey-cli profile application-set --instance <id> --application <应用 ID> --profile <配置 ID 或名称>
  axonkey-cli profile application-remove --instance <id> --application <应用 ID>
  axonkey-cli profile application-toggle --instance <id> --on|--off
  axonkey-cli capture list [--with-gatt] [--json]
  axonkey-cli capture attach --instance-id <ID> [--allow-caution] [--allow-primary-input] [--json]
  axonkey-cli capture detach --instance-id <ID> [--json]
  axonkey-cli capture key --instance-id <ID> --input-id <ID> [--label <名称>] [--timeout-ms <毫秒>] [--baseline-ms <毫秒>] [--json]
  axonkey-cli capture wizard --instance-id <ID> --draft <draft.svg> [--out <out.svg>] [--session-file <capture.json>] [--markdown-out <out.md>] [--status <active|draft>] [--json]
  axonkey-cli capture compile --draft <draft.svg> --session <capture.json> --out <out.svg> [--markdown-out <out.md>] [--status <active|draft>] [--json]

常用参数：
  --instance <id>            明确指定 device list 返回的设备实例
  --device <kind>            按型号选择唯一实例；同型号多台时使用 --instance
  --profile <id 或名称>      省略时使用设备当前激活配置
  --button <id>              按键；--input 为别名
  --trigger <click|doubleClick|longPress>
  --keys <Mod+Shift+P>       设置快捷键
  --sequence <json>          设置完整行为序列
  --actions <json>           --sequence 的别名；行为格式见 capabilities
  --action <json>            设置单个行为对象
  --quick                    新建或复制为快捷交互配置
  --prompt-mode              创建快捷交互配置时直接开启纯 Prompt 模式
  --preset <slug|id|名称>    指定云端或内置预制配置文件
  --mode <copy|overwrite>    preset apply 模式：复制为新配置（默认）或覆盖指定配置
  --dry-run                  只返回变更预览
  --yes                      确认清除或删除操作

预制配置与快捷交互窗：
  preset list --device rc003 --json
  preset apply --instance <id> --preset mouse-control --json
  profile create --instance <id> --name "AI 提示词" --quick --prompt-mode --json
  mapping set --instance <id> --profile "AI 提示词" --button up \
    --sequence '[{"type":"paste","text":"请分析这个报错","title":"代码排错"}]' --json
  mapping set --instance <id> --button menu --trigger click \
    --sequence '[{"type":"quickOverlay","profileId":"<快捷配置 ID>"}]' --json

循环配置：
  mapping set --instance <id> --button <TV 按键 ID> \
    --sequence '[{"type":"switchProfile","direction":"next","wrap":true}]'
  此绑定应用于该设备所有配置，之后新建的配置也会继承。

Mod 在 Windows 上表示 Ctrl，在 macOS 上表示 Cmd。"#
    );
}

#[derive(Debug, PartialEq, Eq)]
enum CaptureCliCommand {
    List {
        with_gatt: bool,
        json: bool,
    },
    Attach {
        instance_id: String,
        allow_caution: bool,
        allow_primary_input: bool,
        json: bool,
    },
    Detach {
        instance_id: String,
        json: bool,
    },
    Key {
        instance_id: String,
        input_id: String,
        label: Option<String>,
        timeout_ms: u64,
        baseline_ms: u64,
        json: bool,
    },
    Wizard {
        instance_id: String,
        draft: PathBuf,
        out: PathBuf,
        session_file: Option<PathBuf>,
        markdown_out: Option<PathBuf>,
        status: Option<String>,
        timeout_ms: u64,
        baseline_ms: u64,
        json: bool,
    },
    Compile {
        draft: PathBuf,
        session: PathBuf,
        out: PathBuf,
        markdown_out: Option<PathBuf>,
        status: Option<String>,
        json: bool,
    },
}

fn parse_capture_command(args: &[String]) -> Result<CaptureCliCommand, CliFailure> {
    let sub = args
        .get(1)
        .ok_or_else(|| {
            CliFailure::usage(
                "缺少 capture 子命令，可用：list、attach、detach、key、wizard、compile",
            )
        })?
        .as_str();

    let mut flags: Map<String, Value> = Map::new();
    let mut index = 2;
    while index < args.len() {
        let token = &args[index];
        if !token.starts_with("--") {
            return Err(CliFailure::usage(format!("无法识别参数“{token}”")));
        }
        let name = token.trim_start_matches('-');
        if matches!(
            name,
            "json" | "with-gatt" | "allow-caution" | "allow-primary-input"
        ) {
            flags.insert(name.into(), Value::Bool(true));
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .filter(|val| !val.starts_with("--"))
            .ok_or_else(|| CliFailure::usage(format!("参数“{token}”缺少值")))?;
        if !matches!(
            name,
            "instance-id"
                | "input-id"
                | "label"
                | "timeout-ms"
                | "baseline-ms"
                | "draft"
                | "out"
                | "session-file"
                | "session"
                | "markdown-out"
                | "status"
        ) {
            return Err(CliFailure::usage(format!("capture 不支持参数“{token}”")));
        }
        flags.insert(name.into(), Value::String(value.clone()));
        index += 2;
    }

    let json = flags.get("json").and_then(Value::as_bool).unwrap_or(false);
    let req_str = |key: &str| -> Result<String, CliFailure> {
        flags
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| CliFailure::usage(format!("缺少必填参数 --{key}")))
    };
    let opt_u64 = |key: &str, default: u64| -> Result<u64, CliFailure> {
        match flags.get(key).and_then(Value::as_str) {
            Some(raw) => raw
                .parse::<u64>()
                .map_err(|_| CliFailure::usage(format!("--{key} 需要非负整数：{raw}"))),
            None => Ok(default),
        }
    };

    match sub {
        "list" => Ok(CaptureCliCommand::List {
            with_gatt: flags
                .get("with-gatt")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            json,
        }),
        "attach" => Ok(CaptureCliCommand::Attach {
            instance_id: req_str("instance-id")?,
            allow_caution: flags
                .get("allow-caution")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            allow_primary_input: flags
                .get("allow-primary-input")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            json,
        }),
        "detach" => Ok(CaptureCliCommand::Detach {
            instance_id: req_str("instance-id")?,
            json,
        }),
        "key" => Ok(CaptureCliCommand::Key {
            instance_id: req_str("instance-id")?,
            input_id: req_str("input-id")?,
            label: flags
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_owned),
            timeout_ms: opt_u64("timeout-ms", 20_000)?,
            baseline_ms: opt_u64("baseline-ms", 300)?,
            json,
        }),
        "wizard" => {
            let draft = PathBuf::from(req_str("draft")?);
            let out = flags
                .get("out")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| draft.with_extension("captured.svg"));
            Ok(CaptureCliCommand::Wizard {
                instance_id: req_str("instance-id")?,
                draft,
                out,
                session_file: flags
                    .get("session-file")
                    .and_then(Value::as_str)
                    .map(PathBuf::from),
                markdown_out: flags
                    .get("markdown-out")
                    .and_then(Value::as_str)
                    .map(PathBuf::from),
                status: flags
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                timeout_ms: opt_u64("timeout-ms", 20_000)?,
                baseline_ms: opt_u64("baseline-ms", 300)?,
                json,
            })
        }
        "compile" => Ok(CaptureCliCommand::Compile {
            draft: PathBuf::from(req_str("draft")?),
            session: PathBuf::from(req_str("session")?),
            out: PathBuf::from(req_str("out")?),
            markdown_out: flags
                .get("markdown-out")
                .and_then(Value::as_str)
                .map(PathBuf::from),
            status: flags
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned),
            json,
        }),
        other => Err(CliFailure::usage(format!(
            "不支持的子命令：capture {other}"
        ))),
    }
}

fn wrap_cli_ok(result: Value) -> Result<String, CliFailure> {
    serde_json::to_string_pretty(&serde_json::json!({
        "protocol": SCHEMA,
        "ok": true,
        "result": result,
    }))
    .map_err(|e| CliFailure::execution(format!("格式化 JSON 失败：{e}")))
}

fn run_capture_command(args: &[String]) -> Result<String, CliFailure> {
    use axonkey_lib::device_capture::{
        self, CaptureEvent, CaptureSafetyTier, CaptureSessionFile, CapturedKeySample,
    };

    match parse_capture_command(args)? {
        CaptureCliCommand::List { with_gatt, json } => {
            let candidates =
                device_capture::list_candidates(with_gatt).map_err(CliFailure::execution)?;
            if json {
                wrap_cli_ok(serde_json::json!({ "candidates": candidates }))
            } else if candidates.is_empty() {
                Ok("未检测到可用物理输入候选设备。".into())
            } else {
                let mut lines = Vec::with_capacity(candidates.len());
                for c in candidates {
                    let tier = match c.safety_tier {
                        CaptureSafetyTier::Safe => "safe",
                        CaptureSafetyTier::Caution => "caution",
                        CaptureSafetyTier::Blocked => "blocked",
                    };
                    let vp = match (c.vid, c.pid) {
                        (Some(v), Some(p)) => format!("{v:04X}:{p:04X}"),
                        _ => "----:----".into(),
                    };
                    let bound = if c.bound_to_quarbor {
                        " [已挂载Quarbor]"
                    } else {
                        ""
                    };
                    lines.push(format!(
                        "[{tier}] {} ({}, {vp}){bound}\n  instanceId: {}",
                        c.display_name, c.transport, c.instance_id
                    ));
                }
                Ok(lines.join("\n"))
            }
        }
        CaptureCliCommand::Attach {
            instance_id,
            allow_caution,
            allow_primary_input,
            json,
        } => {
            let outcome = device_capture::attach_driver(
                &instance_id,
                allow_caution,
                allow_primary_input,
                None,
                None,
            )
            .map_err(CliFailure::execution)?;
            if outcome.cancelled_by_user {
                return Err(CliFailure::uac_cancelled(
                    outcome
                        .message
                        .unwrap_or_else(|| "已取消管理员授权，驱动挂载未完成。".into()),
                    &outcome.instance_id,
                    outcome.bound_to_quarbor,
                ));
            }
            if json {
                wrap_cli_ok(serde_json::to_value(&outcome).unwrap_or(Value::Null))
            } else {
                Ok(format!(
                    "已为节点 {} 挂载 Quarbor 拦截驱动（bound={}，rebootRequired={}）。",
                    outcome.instance_id, outcome.bound_to_quarbor, outcome.reboot_required
                ))
            }
        }
        CaptureCliCommand::Detach { instance_id, json } => {
            let outcome = device_capture::detach_driver(&instance_id, None, None)
                .map_err(CliFailure::execution)?;
            if outcome.cancelled_by_user {
                return Err(CliFailure::uac_cancelled(
                    outcome
                        .message
                        .unwrap_or_else(|| "已取消管理员授权，驱动恢复未完成。".into()),
                    &outcome.instance_id,
                    outcome.bound_to_quarbor,
                ));
            }
            if json {
                wrap_cli_ok(serde_json::to_value(&outcome).unwrap_or(Value::Null))
            } else {
                Ok(format!(
                    "已恢复节点 {} 的系统原驱动（bound={}，rebootRequired={}）。",
                    outcome.instance_id, outcome.bound_to_quarbor, outcome.reboot_required
                ))
            }
        }
        CaptureCliCommand::Key {
            instance_id,
            input_id,
            label,
            timeout_ms,
            baseline_ms,
            json,
        } => {
            let display = label.as_deref().unwrap_or(&input_id);
            eprintln!("请按下并松开【{display}】（{input_id}）…");
            let (sample, streaming_ids) = device_capture::capture_single_key(
                &instance_id,
                &input_id,
                baseline_ms,
                timeout_ms,
            )
            .map_err(CliFailure::execution)?;
            if json {
                wrap_cli_ok(serde_json::json!({
                    "sample": sample,
                    "streamingReportIds": streaming_ids,
                }))
            } else {
                Ok(format!(
                    "{input_id}: report=0x{:02X} press=[{}] release=[{}] hold={}",
                    sample.report_id, sample.press_hex, sample.release_hex, sample.hold_count
                ))
            }
        }
        CaptureCliCommand::Wizard {
            instance_id,
            draft,
            out,
            session_file,
            markdown_out,
            status,
            timeout_ms,
            baseline_ms,
            json,
        } => {
            let draft_svg = fs::read_to_string(&draft).map_err(|e| {
                CliFailure::execution(format!("无法读取草稿 SVG {}：{e}", draft.display()))
            })?;
            let parsed_draft =
                device_capture::parse_draft_svg(&draft_svg).map_err(CliFailure::execution)?;
            if parsed_draft.inputs.is_empty() {
                return Err(CliFailure::execution(
                    "草稿 SVG 中未找到任何待采集的按键输入项。",
                ));
            }

            let session_path = session_file.unwrap_or_else(|| draft.with_extension("capture.json"));
            let mut session_data = if session_path.is_file() {
                load_capture_session_file(&session_path)?
            } else {
                CaptureSessionFile {
                    schema: device_capture::CAPTURE_SESSION_SCHEMA.into(),
                    candidate: None,
                    samples: Vec::new(),
                }
            };

            if session_data.candidate.is_none() {
                if let Ok(list) = device_capture::list_candidates(true) {
                    session_data.candidate = list
                        .into_iter()
                        .find(|c| c.instance_id.eq_ignore_ascii_case(&instance_id));
                }
            }

            let (sample_tx, sample_rx) = std::sync::mpsc::channel::<CapturedKeySample>();
            let sink = std::sync::Arc::new(move |event: CaptureEvent| {
                if let CaptureEvent::KeyCaptured { sample } = event {
                    let _ = sample_tx.send(sample);
                }
            });

            device_capture::start_session(
                format!("wizard:{instance_id}"),
                instance_id.clone(),
                false,
                sink,
            )
            .map_err(CliFailure::execution)?;

            let loop_result = (|| -> Result<(), CliFailure> {
                if baseline_ms > 0 {
                    thread::sleep(Duration::from_millis(baseline_ms.min(5_000)));
                }
                let total = parsed_draft.inputs.len();
                for (idx, item) in parsed_draft.inputs.iter().enumerate() {
                    let already_captured = item.binding == "captured"
                        || session_data.samples.iter().any(|s| s.input_id == item.id);
                    if already_captured {
                        eprintln!(
                            "[{}/{}] 跳过已采集按键【{}】（{}）",
                            idx + 1,
                            total,
                            item.label,
                            item.id
                        );
                        continue;
                    }
                    while sample_rx.try_recv().is_ok() {}
                    eprintln!(
                        "[{}/{}] 请按下并松开【{}】（{}）…",
                        idx + 1,
                        total,
                        item.label,
                        item.id
                    );
                    device_capture::arm_key(Some(item.id.clone()))
                        .map_err(CliFailure::execution)?;
                    match sample_rx.recv_timeout(Duration::from_millis(timeout_ms.max(500))) {
                        Ok(sample) => {
                            eprintln!(
                                "  ✓ {} => press=[{}] release=[{}]",
                                item.label, sample.press_hex, sample.release_hex
                            );
                            session_data.samples.retain(|s| s.input_id != item.id);
                            session_data.samples.push(sample);
                            save_capture_session_file(&session_path, &session_data)?;
                        }
                        Err(_) => {
                            let _ = device_capture::arm_key(None);
                            eprintln!("  ↷ 超时跳过【{}】，保留 pending", item.label);
                        }
                    }
                }
                Ok(())
            })();

            let _ = device_capture::stop_session();
            loop_result?;

            save_capture_session_file(&session_path, &session_data)?;
            let compiled = device_capture::compile_svg(
                &draft_svg,
                session_data.candidate.as_ref(),
                &session_data.samples,
                status.as_deref(),
            )
            .map_err(CliFailure::execution)?;

            let md_path_str = markdown_out
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned());
            device_capture::save_export(
                &out.to_string_lossy(),
                &compiled.svg_content,
                md_path_str.as_deref(),
                Some(&compiled.markdown_summary),
            )
            .map_err(CliFailure::execution)?;

            if json {
                wrap_cli_ok(serde_json::json!({
                    "out": out,
                    "sessionFile": session_path,
                    "markdownOut": markdown_out,
                    "adaptedCount": compiled.adapted_count,
                    "pendingCount": compiled.pending_count,
                    "collisions": compiled.collisions,
                    "validated": compiled.validated,
                }))
            } else {
                Ok(format!(
                    "已完成向导采集并写入 {}（已采集 {} 键，待采集 {} 键，会话存档 {}）。",
                    out.display(),
                    compiled.adapted_count,
                    compiled.pending_count,
                    session_path.display()
                ))
            }
        }
        CaptureCliCommand::Compile {
            draft,
            session,
            out,
            markdown_out,
            status,
            json,
        } => {
            let draft_svg = fs::read_to_string(&draft).map_err(|e| {
                CliFailure::execution(format!("无法读取草稿 SVG {}：{e}", draft.display()))
            })?;
            let session_data = load_capture_session_file(&session)?;
            let compiled = device_capture::compile_svg(
                &draft_svg,
                session_data.candidate.as_ref(),
                &session_data.samples,
                status.as_deref(),
            )
            .map_err(CliFailure::execution)?;

            let md_path_str = markdown_out
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned());
            device_capture::save_export(
                &out.to_string_lossy(),
                &compiled.svg_content,
                md_path_str.as_deref(),
                Some(&compiled.markdown_summary),
            )
            .map_err(CliFailure::execution)?;

            if json {
                wrap_cli_ok(serde_json::json!({
                    "out": out,
                    "markdownOut": markdown_out,
                    "adaptedCount": compiled.adapted_count,
                    "pendingCount": compiled.pending_count,
                    "collisions": compiled.collisions,
                    "validated": compiled.validated,
                }))
            } else {
                Ok(format!(
                    "已编译设备描述 SVG 至 {}（已适配 {} 键，待适配 {} 键，冲突 {} 项）。",
                    out.display(),
                    compiled.adapted_count,
                    compiled.pending_count,
                    compiled.collisions.len()
                ))
            }
        }
    }
}

fn load_capture_session_file(
    path: &Path,
) -> Result<axonkey_lib::device_capture::CaptureSessionFile, CliFailure> {
    let raw = fs::read_to_string(path).map_err(|e| {
        CliFailure::execution(format!("无法读取采集会话文件 {}：{e}", path.display()))
    })?;
    let trimmed = raw.trim_start_matches('\u{feff}').trim();
    if trimmed.starts_with('[') {
        let samples: Vec<axonkey_lib::device_capture::CapturedKeySample> =
            serde_json::from_str(trimmed)
                .map_err(|e| CliFailure::execution(format!("采集样本数组 JSON 格式无效：{e}")))?;
        Ok(axonkey_lib::device_capture::CaptureSessionFile {
            schema: axonkey_lib::device_capture::CAPTURE_SESSION_SCHEMA.into(),
            candidate: None,
            samples,
        })
    } else {
        serde_json::from_str(trimmed)
            .map_err(|e| CliFailure::execution(format!("采集会话 JSON 格式无效：{e}")))
    }
}

fn save_capture_session_file(
    path: &Path,
    session: &axonkey_lib::device_capture::CaptureSessionFile,
) -> Result<(), CliFailure> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| {
                CliFailure::execution(format!("无法创建会话目录 {}：{e}", parent.display()))
            })?;
        }
    }
    let content = serde_json::to_vec_pretty(session)
        .map_err(|e| CliFailure::execution(format!("无法序列化采集会话：{e}")))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, content)
        .map_err(|e| CliFailure::execution(format!("无法写入采集会话临时文件：{e}")))?;
    fs::rename(&temp, path).map_err(|e| CliFailure::execution(format!("无法保存采集会话文件：{e}")))
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
    fn rejects_unknown_subcommands_standalone_arguments_and_conflicting_toggles() {
        for values in [
            vec!["status", "--device", "mouse"],
            vec!["capabilities", "garbage"],
            vec!["profile", "destroy"],
            vec!["preset", "remove"],
            vec!["profile", "application-toggle", "--on", "--off"],
            vec!["device", "toggle", "--on", "--off"],
            vec!["profile", "prompt-mode", "--on", "--off"],
            vec!["preset", "apply", "--preset", "--json"],
            vec!["preset", "apply", "--mode"],
        ] {
            assert_eq!(parse_operation(&args(&values)).unwrap_err().exit_code, 2);
        }
        assert_eq!(
            parse_operation(&args(&["status", "--json"])).unwrap().0,
            "status"
        );
    }

    #[test]
    fn parses_quick_profile_lifecycle_preset_and_device_toggle_operations() {
        let (method, params) = parse_operation(&args(&[
            "profile",
            "create",
            "--instance",
            "remote-1",
            "--name",
            "AI 提示词",
            "--quick",
            "--prompt-mode",
            "--dry-run",
        ]))
        .unwrap();
        assert_eq!(method, "profile.create");
        assert_eq!(params["quick"], true);
        assert_eq!(params["promptMode"], true);
        assert_eq!(params["dryRun"], true);

        let (method, params) = parse_operation(&args(&[
            "profile",
            "rename",
            "--instance",
            "remote-1",
            "--profile",
            "默认配置",
            "--name",
            "日常控制",
        ]))
        .unwrap();
        assert_eq!(method, "profile.rename");
        assert_eq!(params["profile"], "默认配置");
        assert_eq!(params["name"], "日常控制");

        let (method, params) = parse_operation(&args(&[
            "profile",
            "duplicate",
            "--instance",
            "remote-1",
            "--profile",
            "日常控制",
            "--quick",
        ]))
        .unwrap();
        assert_eq!(method, "profile.duplicate");
        assert_eq!(params["quick"], true);

        let (method, params) = parse_operation(&args(&[
            "profile",
            "delete",
            "--instance",
            "remote-1",
            "--profile",
            "旧配置",
            "--yes",
        ]))
        .unwrap();
        assert_eq!(method, "profile.delete");
        assert_eq!(params["yes"], true);

        let (method, params) = parse_operation(&args(&[
            "profile",
            "prompt-mode",
            "--instance",
            "remote-1",
            "--profile",
            "AI 提示词",
            "--off",
        ]))
        .unwrap();
        assert_eq!(method, "profile.prompt-mode");
        assert_eq!(params["enabled"], false);

        let (method, params) =
            parse_operation(&args(&["preset", "list", "--device", "rc003", "--json"])).unwrap();
        assert_eq!(method, "preset.list");
        assert_eq!(params["device"], "rc003");
        assert_eq!(params["json"], true);

        let (method, params) = parse_operation(&args(&[
            "preset",
            "apply",
            "--instance",
            "remote-1",
            "--preset",
            "mouse-control",
            "--mode",
            "overwrite",
            "--profile",
            "默认配置",
            "--dry-run",
        ]))
        .unwrap();
        assert_eq!(method, "preset.apply");
        assert_eq!(params["preset"], "mouse-control");
        assert_eq!(params["mode"], "overwrite");
        assert_eq!(params["profile"], "默认配置");
        assert_eq!(params["dryRun"], true);

        let (method, params) = parse_operation(&args(&[
            "device",
            "toggle",
            "--instance",
            "remote-1",
            "--off",
        ]))
        .unwrap();
        assert_eq!(method, "device.toggle");
        assert_eq!(params["instance"], "remote-1");
        assert_eq!(params["enabled"], false);
    }

    #[test]
    fn rejects_malformed_response_instead_of_reporting_success() {
        for response in [
            serde_json::json!({}),
            serde_json::json!({"protocol": SCHEMA}),
            serde_json::json!({"protocol": "other", "ok": true}),
            serde_json::json!({"protocol": SCHEMA, "ok": "false"}),
        ] {
            assert_eq!(format_response(response).unwrap_err().exit_code, 3);
        }
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

    #[test]
    fn parses_capture_subcommands_and_validates_flags() {
        assert_eq!(
            parse_capture_command(&args(&["capture", "list", "--with-gatt", "--json"])).unwrap(),
            CaptureCliCommand::List {
                with_gatt: true,
                json: true
            }
        );
        assert_eq!(
            parse_capture_command(&args(&[
                "capture",
                "attach",
                "--instance-id",
                "BTHLEDEVICE\\1",
                "--allow-caution",
                "--json"
            ]))
            .unwrap(),
            CaptureCliCommand::Attach {
                instance_id: "BTHLEDEVICE\\1".into(),
                allow_caution: true,
                allow_primary_input: false,
                json: true,
            }
        );
        assert_eq!(
            parse_capture_command(&args(&[
                "capture",
                "key",
                "--instance-id",
                "BTHLEDEVICE\\1",
                "--input-id",
                "rc.mute",
                "--label",
                "静音",
                "--timeout-ms",
                "12000",
                "--baseline-ms",
                "250",
            ]))
            .unwrap(),
            CaptureCliCommand::Key {
                instance_id: "BTHLEDEVICE\\1".into(),
                input_id: "rc.mute".into(),
                label: Some("静音".into()),
                timeout_ms: 12_000,
                baseline_ms: 250,
                json: false,
            }
        );
        assert_eq!(
            parse_capture_command(&args(&[
                "capture",
                "wizard",
                "--instance-id",
                "BTHLEDEVICE\\1",
                "--draft",
                "docs/device-drafts/tcl-rc802a.svg",
                "--session-file",
                "docs/device-drafts/tcl-rc802a.capture.json",
            ]))
            .unwrap(),
            CaptureCliCommand::Wizard {
                instance_id: "BTHLEDEVICE\\1".into(),
                draft: PathBuf::from("docs/device-drafts/tcl-rc802a.svg"),
                out: PathBuf::from("docs/device-drafts/tcl-rc802a.captured.svg"),
                session_file: Some(PathBuf::from("docs/device-drafts/tcl-rc802a.capture.json")),
                markdown_out: None,
                status: None,
                timeout_ms: 20_000,
                baseline_ms: 300,
                json: false,
            }
        );

        let uac_err = CliFailure::uac_cancelled("已取消管理员授权", "BTHLEDEVICE\\1", false);
        assert_eq!(uac_err.exit_code, 4);
        let uac_json = uac_err.json_response();
        assert_eq!(uac_json["protocol"], SCHEMA);
        assert_eq!(uac_json["ok"], false);
        assert_eq!(uac_json["error"]["code"], "permission_denied");
        assert_eq!(uac_json["error"]["cancelledByUser"], true);
        assert_eq!(uac_json["error"]["instanceId"], "BTHLEDEVICE\\1");

        assert_eq!(
            parse_capture_command(&args(&["capture"]))
                .unwrap_err()
                .exit_code,
            2
        );
        assert_eq!(
            parse_capture_command(&args(&["capture", "attach"]))
                .unwrap_err()
                .exit_code,
            2
        );
        assert_eq!(
            parse_capture_command(&args(&[
                "capture",
                "key",
                "--instance-id",
                "X",
                "--input-id",
                "Y",
                "--timeout-ms",
                "bad"
            ]))
            .unwrap_err()
            .exit_code,
            2
        );
    }

    #[test]
    fn executes_capture_compile_end_to_end_with_json_envelope() {
        let dir = env::temp_dir().join(format!("axonkey-cli-capture-{}", request_id()));
        fs::create_dir_all(&dir).unwrap();
        let draft_path = dir.join("draft.svg");
        let session_path = dir.join("session.json");
        let out_svg = dir.join("out.svg");
        let out_md = dir.join("out.md");

        let draft = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:ak="urn:axonkey:device:1" viewBox="0 0 200 400" data-ak-schema="axonkey.device/1" data-ak-device="cli-test" data-ak-revision="1" data-ak-status="draft">
  <metadata>
    <ak:device schema="axonkey.device/1" id="cli-test" vendor="CLI" model="T1" revision="1" display-name="CLI T1" status="draft">
      <ak:inputs>
        <ak:input id="cli-test.mute" label="静音" kind="button" target="#key-mute" order="0" original="false" binding="pending"/>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="key-mute" data-ak-key="cli-test.mute"><circle cx="50" cy="50" r="20"/></g>
</svg>"##;
        fs::write(&draft_path, draft).unwrap();

        let session_json = serde_json::json!({
            "schema": "axonkey.capture-session/v1",
            "samples": [{
                "inputId": "cli-test.mute",
                "reportId": 1,
                "pressHex": "01 00 00 EF 00 00 00 00 00",
                "releaseHex": "01 00 00 00 00 00 00 00 00",
                "pressLength": 9,
                "releaseLength": 9,
                "holdCount": 2,
                "durationMs": 95
            }]
        });
        fs::write(
            &session_path,
            serde_json::to_vec_pretty(&session_json).unwrap(),
        )
        .unwrap();

        let raw_output = run(args(&[
            "capture",
            "compile",
            "--draft",
            &draft_path.to_string_lossy(),
            "--session",
            &session_path.to_string_lossy(),
            "--out",
            &out_svg.to_string_lossy(),
            "--markdown-out",
            &out_md.to_string_lossy(),
            "--status",
            "active",
            "--json",
        ]))
        .unwrap();

        let parsed: Value = serde_json::from_str(&raw_output).unwrap();
        assert_eq!(parsed["protocol"], SCHEMA);
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["result"]["adaptedCount"], 1);
        assert_eq!(parsed["result"]["pendingCount"], 0);
        assert_eq!(parsed["result"]["validated"], true);
        assert!(out_svg.is_file());
        assert!(out_md.is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn compiles_cleared_svg_inputs_as_pending_without_resurrecting_old_bindings() {
        let rc902n = include_str!("../../../public/device-descriptors/tcl-rc902n.svg");
        let single_cleared = rc902n.replace(
            r##"<ak:input id="tcl-rc902n.bookmark" label="书签图标键" short="书签" icon="center" kind="button" order="3" target="#key-bookmark" original="false" binding="captured"><ak:source report="captured-buttons" offset="1" bit="0" width="16" equals="0x0059"/><ak:hid-capture version="1" press="03 59 00" press-length="3" release="03 00 00" release-length="3"/></ak:input>"##,
            r##"<ak:input id="tcl-rc902n.bookmark" label="书签图标键" short="书签" icon="center" kind="button" order="3" target="#key-bookmark" original="false" binding="pending"/>"##,
        );
        let parsed = axonkey_lib::device_capture::parse_draft_svg(&single_cleared).unwrap();
        let bookmark = parsed
            .inputs
            .iter()
            .find(|i| i.id == "tcl-rc902n.bookmark")
            .unwrap();
        assert_eq!(bookmark.binding, "pending");
        assert!(bookmark.press_hex.is_none());

        let compiled =
            axonkey_lib::device_capture::compile_svg(&single_cleared, None, &[], Some("draft"))
                .unwrap();
        assert!(compiled.validated);
        assert_eq!(compiled.adapted_count, 21);
        assert_eq!(compiled.pending_count, 1);
        assert!(compiled.svg_content.contains("id=\"voice-audio\""));
        assert!(!compiled.svg_content.contains("press=\"03 59 00\""));
    }
}
