.PHONY: uninstall-driver

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
