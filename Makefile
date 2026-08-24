.PHONY: dev version-check build build-macos test-release release uninstall-driver

ENV_FILE ?= .env

dev:
	npm run tauri dev

build:
	ENV_FILE="$(ENV_FILE)" node ./scripts/build.mjs

release:
	ENV_FILE="$(ENV_FILE)" node ./scripts/release.mjs "$(V)"

version-check:
	node ./scripts/repo-version.mjs check --env-file "$(ENV_FILE)"

build-macos: version-check
	node ./scripts/build-macos.mjs

test-release:
	npm run test:release

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\openinputbridge-driver.ps1" -Action Uninstall
