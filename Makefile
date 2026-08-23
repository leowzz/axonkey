.PHONY: dev build uninstall-driver

dev:
	npm run tauri dev

build:
	npm run tauri build

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
