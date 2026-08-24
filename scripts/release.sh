#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_TOOL="$ROOT/scripts/repo-version.mjs"
VERSION_FILES=(
  .env.example
  package.json
  package-lock.json
  src-tauri/Cargo.toml
  src-tauri/Cargo.lock
  src-tauri/tauri.conf.json
)
cd "$ROOT"

node "$VERSION_TOOL" get >/dev/null

dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" ]]; then
  echo "release: worktree must be clean:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

if [[ -n "${V:-}" ]]; then
  new_version="${V//$'\r'/}"
else
  new_version="$(node "$VERSION_TOOL" get --bump-patch)"
fi
if [[ ! "$new_version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "release: expected V=vX.Y.Z, got ${new_version:-<empty>}" >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/tags/$new_version"; then
  echo "release: git tag already exists: $new_version" >&2
  exit 1
fi

node "$VERSION_TOOL" set "$new_version"
node "$VERSION_TOOL" check "$new_version"
git add -- "${VERSION_FILES[@]}"
if ! git diff --cached --quiet --; then
  git commit -m "chore: release $new_version" -- "${VERSION_FILES[@]}"
fi
git tag -a "$new_version" -m "release $new_version"
echo "release: version=$new_version committed and tagged"
