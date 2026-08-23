#!/bin/bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "usage: $0 <dmg> [dmg ...]" >&2
  exit 64
fi

work_dir=""
device=""
mount_point=""

cleanup() {
  if [[ -n "$device" ]]; then
    hdiutil detach "$device" -quiet || true
  elif [[ -n "$mount_point" && -d "$mount_point" ]]; then
    hdiutil detach "$mount_point" -quiet 2>/dev/null || true
  fi
  if [[ -n "$work_dir" ]]; then
    case "$work_dir" in
      /private/tmp/axonkey-dmg.*|/tmp/axonkey-dmg.*) rm -rf -- "$work_dir" ;;
      *) echo "refusing to clean unexpected work path: $work_dir" >&2 ;;
    esac
  fi
}
trap cleanup EXIT

for dmg in "$@"; do
  if [[ ! -f "$dmg" ]]; then
    echo "DMG not found: $dmg" >&2
    exit 66
  fi
  dmg_is_signed=0
  if codesign -d "$dmg" >/dev/null 2>&1; then
    dmg_is_signed=1
  fi
  if [[ "$dmg_is_signed" -eq 1 && -z "${DMG_SIGNING_IDENTITY:-}" ]]; then
    echo "refusing to rewrite a signed DMG; remove the volume icon before signing" >&2
    exit 65
  fi

  dmg="$(cd "$(dirname "$dmg")" && pwd)/$(basename "$dmg")"
  work_dir="$(mktemp -d /private/tmp/axonkey-dmg.XXXXXX)"
  mount_point="$work_dir/mount"
  writable_dmg="$work_dir/writable.dmg"
  output_dmg="$work_dir/output.dmg"
  mkdir "$mount_point"

  hdiutil convert "$dmg" -quiet -format UDRW -o "$writable_dmg"
  device="$(hdiutil attach "$writable_dmg" -readwrite -noverify -noautoopen -nobrowse -mountpoint "$mount_point" | awk '/^\/dev\// { print $1; exit }')"
  if [[ -z "$device" ]]; then
    echo "failed to mount writable DMG: $dmg" >&2
    exit 1
  fi

  if [[ -e "$mount_point/.VolumeIcon.icns" ]]; then
    rm -- "$mount_point/.VolumeIcon.icns"
  fi
  SetFile -a c "$mount_point"
  sync
  hdiutil detach "$device" -quiet
  device=""

  hdiutil convert "$writable_dmg" -quiet -format UDZO -imagekey zlib-level=9 -o "$output_dmg"
  mv -f -- "$output_dmg" "$dmg"
  if [[ -n "${DMG_SIGNING_IDENTITY:-}" && "$DMG_SIGNING_IDENTITY" != "-" ]]; then
    codesign --force --sign "$DMG_SIGNING_IDENTITY" "$dmg"
  fi
  rm -rf -- "$work_dir"
  work_dir=""
  mount_point=""

  echo "Removed .VolumeIcon.icns from $dmg"
done
