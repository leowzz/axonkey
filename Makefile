.PHONY: dev uninstall-driver

dev:
	npm run tauri dev

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
