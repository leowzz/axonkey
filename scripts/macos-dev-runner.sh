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

VERSION="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/src-tauri/tauri.conf.json")"

/bin/mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
/bin/cp -f "$BIN_ABS" "$APP_EXEC"
/bin/chmod 755 "$APP_EXEC"
/bin/cp -f "$ROOT/src-tauri/icons/icon.icns" "$RESOURCES_DIR/icon.icns"

if [[ -d "$ROOT/src-tauri/resources/macos" ]]; then
  /bin/mkdir -p "$RESOURCES_DIR/resources/macos"
  for pkg in "$ROOT"/src-tauri/resources/macos/*.pkg(N); do
    /bin/cp -f "$pkg" "$RESOURCES_DIR/resources/macos/"
  done
fi

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

if /usr/bin/pgrep -f "^${APP_EXEC}( |$)" >/dev/null 2>&1; then
  /usr/bin/pkill -TERM -f "^${APP_EXEC}( |$)" 2>/dev/null || true
  /bin/sleep 0.2
fi

LOG_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/axonkey-dev.XXXXXX")"
STDIO_LOG="$LOG_DIR/stdio.log"
: > "$STDIO_LOG"

/usr/bin/tail -n +1 -f "$STDIO_LOG" &
TAIL_PID=$!
OPEN_PID=""

cleanup() {
  trap - INT TERM HUP EXIT
  [[ -n "$OPEN_PID" ]] && kill "$OPEN_PID" 2>/dev/null || true
  /usr/bin/pkill -TERM -f "^${APP_EXEC}( |$)" 2>/dev/null || true
  [[ -n "$TAIL_PID" ]] && kill "$TAIL_PID" 2>/dev/null || true
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

wait "$OPEN_PID"
