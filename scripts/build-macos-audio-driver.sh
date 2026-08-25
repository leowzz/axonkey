#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
BLACKHOLE_TAG="v0.7.1"
BLACKHOLE_COMMIT="e2b22aaaba4e507a097131704bf96dabc004d9cf"
WORK_ROOT="$ROOT/.build/macos-audio-driver"
SOURCE_ROOT="$WORK_ROOT/BlackHole"
PATCH="$ROOT/third_party/blackhole/blackhole-device-usb.patch"
OUTPUT_ROOT="$ROOT/.build/macos-audio-output"
OUTPUT="$OUTPUT_ROOT/MiRemoteV2ch.driver"
ARCHITECTURE="${MACOS_ARCH:-$(/usr/bin/uname -m)}"
DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
DEFINITIONS='$GCC_PREPROCESSOR_DEFINITIONS kDriver_Name=\"MiRemoteV\" kPlugIn_BundleID=\"com.hd838a.MiRemoteV2ch\" kNumber_Of_Channels=2'

case "$ARCHITECTURE" in
  arm64|x86_64) ;;
  *) print -u2 "Unsupported macOS architecture: $ARCHITECTURE"; exit 1 ;;
esac
case "$WORK_ROOT" in
  "$ROOT"/.build/macos-audio-driver) ;;
  *) print -u2 "Refusing to clean unexpected path: $WORK_ROOT"; exit 1 ;;
esac
case "$OUTPUT" in
  "$ROOT"/.build/macos-audio-output/MiRemoteV2ch.driver) ;;
  *) print -u2 "Refusing to replace unexpected path: $OUTPUT"; exit 1 ;;
esac

command -v git >/dev/null
command -v xcodebuild >/dev/null
/bin/rm -rf -- "$WORK_ROOT" "$OUTPUT_ROOT"
/bin/mkdir -p "${WORK_ROOT:h}" "${OUTPUT:h}"
git clone --depth 1 --branch "$BLACKHOLE_TAG" \
  https://github.com/ExistentialAudio/BlackHole.git "$SOURCE_ROOT"

test "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" = "$BLACKHOLE_COMMIT"
git -C "$SOURCE_ROOT" apply --check "$PATCH"
git -C "$SOURCE_ROOT" apply "$PATCH"

xcodebuild \
  -project "$SOURCE_ROOT/BlackHole.xcodeproj" \
  -target BlackHole \
  -configuration Release \
  -sdk macosx \
  ARCHS="$ARCHITECTURE" \
  ONLY_ACTIVE_ARCH=NO \
  MACOSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
  CODE_SIGNING_ALLOWED=NO \
  PRODUCT_NAME="MiRemoteV2ch" \
  PRODUCT_BUNDLE_IDENTIFIER="com.hd838a.MiRemoteV2ch" \
  GCC_PREPROCESSOR_DEFINITIONS="$DEFINITIONS" \
  build

/usr/bin/ditto --norsrc --noextattr --noqtn --noacl \
  "$SOURCE_ROOT/build/Release/MiRemoteV2ch.driver" "$OUTPUT"
/usr/bin/strip -S "$OUTPUT/Contents/MacOS/MiRemoteV2ch"
if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  /usr/bin/codesign --force --deep --sign - --timestamp=none "$OUTPUT"
else
  /usr/bin/codesign --force --deep --options runtime --timestamp \
    --sign "$SIGNING_IDENTITY" "$OUTPUT"
fi

test "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$OUTPUT/Contents/Info.plist")" = \
  "com.hd838a.MiRemoteV2ch"
test "$(/usr/bin/lipo -archs "$OUTPUT/Contents/MacOS/MiRemoteV2ch")" = "$ARCHITECTURE"
/usr/bin/codesign --verify --deep --strict "$OUTPUT"
print "Built $OUTPUT"
