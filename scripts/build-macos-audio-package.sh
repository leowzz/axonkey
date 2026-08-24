#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
"$ROOT/scripts/build-macos-audio-driver.sh"
"$ROOT/scripts/package-macos-audio-driver.sh"
