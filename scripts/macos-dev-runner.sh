#!/bin/zsh
set -euo pipefail

BIN="${1:?missing executable path}"
shift

if [[ "${BIN:t}" != "axonkey" ]]; then
  exec "$BIN" "$@"
fi

ROOT="${0:A:h:h}"
BIN_ABS="${BIN:A}"
APP_DIR="${BIN_ABS:h}/Axonkey.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"
APP_EXEC="$MACOS_DIR/axonkey"
RUNNER_PID="$$"
RUNNER_PID_FILE="${BIN_ABS:h}/.axonkey-dev-runner.pid"

find_app_pids() {
  /bin/ps -axww -o pid=,comm= | while read -r pid comm; do
    if [[ "$comm" == "$APP_EXEC" ]]; then
      print -r -- "$pid"
    fi
  done
}

stop_running_app() {
  local pids=("${(@f)$(find_app_pids)}")
  pids=(${pids:#})
  (( ${#pids[@]} == 0 )) && return 0

  kill -TERM "${pids[@]}" 2>/dev/null || true
  local alive=()
  for _ in {1..25}; do
    alive=()
    for pid in "${pids[@]}"; do
      kill -0 "$pid" 2>/dev/null && alive+=("$pid")
    done
    (( ${#alive[@]} == 0 )) && return 0
    /bin/sleep 0.05
  done

  kill -KILL "${alive[@]}" 2>/dev/null || true
  for _ in {1..10}; do
    local still_alive=0
    for pid in "${alive[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        still_alive=1
        break
      fi
    done
    (( still_alive == 0 )) && return 0
    /bin/sleep 0.05
  done
}

install_fresh_file() {
  local src="$1"
  local dst="$2"
  local mode="$3"
  /bin/rm -f "$dst"
  /bin/cp "$src" "$dst"
  /bin/chmod "$mode" "$dst"
}

/bin/mkdir -p "${BIN_ABS:h}"
print -r -- "$RUNNER_PID" > "$RUNNER_PID_FILE"

# Stop any previous LaunchServices-spawned Axonkey.app BEFORE touching the bundle,
# and unlink files before writing so macOS never mutates a mapped/cached Mach-O vnode
# in place (which triggers EXC_BAD_ACCESS / CODESIGNING Code 2 Invalid Page).
stop_running_app

VERSION="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/src-tauri/tauri.conf.json")"

/bin/mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
/bin/rm -rf "$CONTENTS/_CodeSignature"
install_fresh_file "$BIN_ABS" "$APP_EXEC" 755
install_fresh_file "$ROOT/src-tauri/icons/icon.icns" "$RESOURCES_DIR/icon.icns" 644

if [[ -d "$ROOT/src-tauri/resources/macos" ]]; then
  /bin/mkdir -p "$RESOURCES_DIR/resources/macos"
  for pkg in "$ROOT"/src-tauri/resources/macos/*.pkg(N); do
    install_fresh_file "$pkg" "$RESOURCES_DIR/resources/macos/${pkg:t}" 644
  done
fi

/bin/rm -f "$CONTENTS/Info.plist"
cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>English</string>
  <key>CFBundleDisplayName</key>
  <string>Axonkey</string>
  <key>CFBundleExecutable</key>
  <string>axonkey</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.axonkey.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Axonkey</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CSResourcesFileMapped</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>连接小米 RC003，接收语音按键产生的麦克风音频。</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

/usr/bin/xattr -cr "$APP_DIR" 2>/dev/null || true

SIGN_ID="${APPLE_SIGNING_IDENTITY:--}"
if [[ "$SIGN_ID" == "-" ]]; then
  /usr/bin/codesign --force --deep --sign - "$APP_DIR"
else
  /usr/bin/codesign --force --deep --options runtime --sign "$SIGN_ID" "$APP_DIR"
fi

LOG_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/axonkey-dev.XXXXXX")"
STDIO_LOG="$LOG_DIR/stdio.log"
: > "$STDIO_LOG"

/usr/bin/tail -n +1 -f "$STDIO_LOG" &
TAIL_PID=$!
OPEN_PID=""
WATCHDOG_PID=""
CLEANED_UP=0

cleanup() {
  (( CLEANED_UP )) && return 0
  CLEANED_UP=1
  [[ -n "$WATCHDOG_PID" ]] && kill "$WATCHDOG_PID" 2>/dev/null || true
  [[ -n "$OPEN_PID" ]] && kill "$OPEN_PID" 2>/dev/null || true
  stop_running_app
  [[ -n "$TAIL_PID" ]] && kill "$TAIL_PID" 2>/dev/null || true
  [[ -n "$WATCHDOG_PID" ]] && wait "$WATCHDOG_PID" 2>/dev/null || true
  [[ -n "$TAIL_PID" ]] && wait "$TAIL_PID" 2>/dev/null || true
  /bin/rm -rf "$LOG_DIR" 2>/dev/null || true
}
trap cleanup INT TERM HUP EXIT

OPEN_ENV_ARGS=()
for var in RUST_LOG RUST_BACKTRACE; do
  if [[ -n "${(P)var:-}" ]]; then
    OPEN_ENV_ARGS+=(--env "${var}=${(P)var}")
  fi
done

# Launch via LaunchServices so macOS TCC attributes Input Monitoring and
# Accessibility to com.axonkey.app instead of the parent terminal process.
/usr/bin/open -n -W \
  --stdout "$STDIO_LOG" \
  --stderr "$STDIO_LOG" \
  "${OPEN_ENV_ARGS[@]}" \
  "$APP_DIR" \
  --args "$@" &
OPEN_PID=$!

# `tauri dev` stops its Cargo runner with SIGKILL on rebuild, bypassing shell
# traps; watch parent liveness so neither tail/open nor the old app bundle leaks.
(
  set +e
  while kill -0 "$RUNNER_PID" 2>/dev/null; do
    /bin/sleep 0.2
  done
  kill "$OPEN_PID" "$TAIL_PID" 2>/dev/null || true
  active_runner=""
  [[ -r "$RUNNER_PID_FILE" ]] && active_runner="$(/bin/cat "$RUNNER_PID_FILE" 2>/dev/null)"
  if [[ "$active_runner" == "$RUNNER_PID" ]]; then
    stop_running_app
  fi
  /bin/rm -rf "$LOG_DIR" 2>/dev/null || true
) </dev/null >/dev/null 2>&1 &
WATCHDOG_PID=$!

STATUS=0
wait "$OPEN_PID" || STATUS=$?
exit "$STATUS"
