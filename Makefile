.PHONY: dev build release uninstall-driver

ENV_FILE ?= .env

dev:
	npm run tauri dev

build:
	ENV_FILE="$(ENV_FILE)" node ./scripts/build.mjs

release:
	ENV_FILE="$(ENV_FILE)" node ./scripts/release.mjs "$(V)"

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
