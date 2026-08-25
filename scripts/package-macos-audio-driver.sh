#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
export COPYFILE_DISABLE=1
DRIVER="$ROOT/.build/macos-audio-output/MiRemoteV2ch.driver"
OUTPUT_ROOT="$ROOT/src-tauri/resources/macos"
WORK_ROOT="$ROOT/.build/macos-audio-package"
INSTALL_ROOT="$WORK_ROOT/install-root"
INSTALL_PKG="$OUTPUT_ROOT/MiRemoteV2ch-Install.pkg"
UNINSTALL_PKG="$OUTPUT_ROOT/MiRemoteV2ch-Uninstall.pkg"
VERSION="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "$DRIVER/Contents/Info.plist")"
INSTALLER_IDENTITY="${MACOS_INSTALLER_SIGNING_IDENTITY:-}"
REQUIRE_SIGNED_INSTALLER="${REQUIRE_SIGNED_INSTALLER:-0}"

case "$REQUIRE_SIGNED_INSTALLER" in
  0|1) ;;
  *) print -u2 "REQUIRE_SIGNED_INSTALLER must be 0 or 1"; exit 1 ;;
esac
if [[ "$REQUIRE_SIGNED_INSTALLER" == "1" && -z "$INSTALLER_IDENTITY" ]]; then
  print -u2 "MACOS_INSTALLER_SIGNING_IDENTITY is required for a signed release"
  exit 1
fi

case "$WORK_ROOT" in
  "$ROOT"/.build/macos-audio-package) ;;
  *) print -u2 "Refusing to clean unexpected path: $WORK_ROOT"; exit 1 ;;
esac
test -d "$DRIVER"
test -x "$DRIVER/Contents/MacOS/MiRemoteV2ch"
/usr/bin/codesign --verify --deep --strict "$DRIVER"

/bin/rm -rf -- "$WORK_ROOT" "$INSTALL_PKG" "$UNINSTALL_PKG"
/bin/mkdir -p "$INSTALL_ROOT/Library/Audio/Plug-Ins/HAL" "$OUTPUT_ROOT"
/usr/bin/ditto --norsrc --noextattr --noqtn --noacl \
  "$DRIVER" "$INSTALL_ROOT/Library/Audio/Plug-Ins/HAL/MiRemoteV2ch.driver"
/usr/bin/codesign --verify --deep --strict \
  "$INSTALL_ROOT/Library/Audio/Plug-Ins/HAL/MiRemoteV2ch.driver"

build_package() {
  local output="$1"
  shift
  if [[ -z "$INSTALLER_IDENTITY" ]]; then
    /usr/bin/pkgbuild "$@" "$output"
    return
  fi
  local unsigned="$WORK_ROOT/${output:t:r}-unsigned.pkg"
  /usr/bin/pkgbuild "$@" "$unsigned"
  /usr/bin/productsign --sign "$INSTALLER_IDENTITY" "$unsigned" "$output"
}

build_package "$INSTALL_PKG" \
  --root "$INSTALL_ROOT" \
  --scripts "$ROOT/packaging/macos-audio/install" \
  --identifier "com.axonkey.MiRemoteV2ch.installer" \
  --version "$VERSION" \
  --install-location "/"

build_package "$UNINSTALL_PKG" \
  --nopayload \
  --scripts "$ROOT/packaging/macos-audio/uninstall" \
  --identifier "com.axonkey.MiRemoteV2ch.uninstaller" \
  --version "$VERSION"

/usr/sbin/pkgutil --check-signature "$INSTALL_PKG" || [[ -z "$INSTALLER_IDENTITY" ]]
/usr/sbin/pkgutil --check-signature "$UNINSTALL_PKG" || [[ -z "$INSTALLER_IDENTITY" ]]
print "Built $INSTALL_PKG"
print "Built $UNINSTALL_PKG"
