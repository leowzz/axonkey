.PHONY: dev build uninstall-driver

dev:
	npm run tauri dev

build:
	node ./scripts/release-build.mjs "$(V)"

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
