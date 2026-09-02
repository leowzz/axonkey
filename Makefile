.PHONY: dev kill clean version-check build build-macos build-macos-audio test-release release uninstall-driver

ENV_FILE ?= .env

dev: kill
	npm run tauri dev

kill:
	pkill -x axonkey || true

clean:
	rm -rf src-tauri/target/release/bundle/macos/Axonkey.app

build:
	ENV_FILE="$(ENV_FILE)" node ./scripts/build.mjs

release:
	ENV_FILE="$(ENV_FILE)" node ./scripts/release.mjs "$(V)"

version-check:
	node ./scripts/repo-version.mjs check --env-file "$(ENV_FILE)"

build-macos: version-check
	node ./scripts/build-macos.mjs

build-macos-audio:
	./scripts/build-macos-audio-package.sh

test-release:
	npm run test:release

uninstall-driver:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\uninstall-driver.ps1"
