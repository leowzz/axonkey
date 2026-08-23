.PHONY: dev version-check build build-macos test-release release uninstall-driver

dev:
	npm run tauri dev

version-check:
	node ./scripts/repo-version.mjs check

build: version-check
	npm run tauri build

build-macos: version-check
	node ./scripts/build-macos.mjs

test-release:
	npm run test:release

# Bump patch in .env and create an annotated tag. Override with: make release V=v1.2.3
release:
	@V="$(V)" bash ./scripts/release.sh

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
