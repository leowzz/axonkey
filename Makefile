.PHONY: dev build build-macos uninstall-driver

dev:
	npm run tauri dev

build:
	node ./scripts/release-build.mjs "$(V)"

build-macos:
	node ./scripts/build-macos.mjs

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
