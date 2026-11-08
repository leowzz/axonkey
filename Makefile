.PHONY: dev kill clean version-check build build-macos build-macos-audio build-uninstall-old-driver check-uninstall-old-driver-git test-release release uninstall-driver help cli-build cli-build-release cli cli-capabilities cli-status cli-device-list cli-profile-list cli-profile-create cli-profile-activate cli-keymap cli-mapping-list cli-mapping-get cli-shortcut-dry-run cli-shortcut-set cli-mapping-dry-run cli-mapping-set cli-mapping-clear test-cli

ENV_FILE ?= .env

# `make` works from Git Bash, macOS, and Linux. On Windows GNU Make exposes
# `OS=Windows_NT`; use the `.exe` produced by Cargo in that case.
ifeq ($(OS),Windows_NT)
CLI_BIN ?= src-tauri/target/debug/axonkey-cli.exe
else
CLI_BIN ?= src-tauri/target/debug/axonkey-cli
endif

CLI_DEVICE_ARGS = $(if $(INSTANCE),--instance "$(INSTANCE)",$(if $(DEVICE),--device "$(DEVICE)"))
CLI_TARGET_ARGS = $(CLI_DEVICE_ARGS) --button "$(BUTTON)" --trigger "$(TRIGGER)" $(if $(PROFILE),--profile "$(PROFILE)")

# Keep JSON out of the Windows shell command line. The CLI runner reads these
# values from the environment and passes them as an argv item to the binary.
export CLI_BIN SEQUENCE ACTIONS

dev: kill
	npm run tauri dev

kill:
	@if command -v pkill >/dev/null 2>&1; then \
		pkill -x axonkey || true; \
	elif command -v powershell.exe >/dev/null 2>&1; then \
		powershell.exe -NoProfile -ExecutionPolicy Bypass -File "./scripts/stop-axonkey.ps1" || true; \
	else \
		echo "No process cleanup command available; continuing."; \
	fi

clean:
	rm -rf src-tauri/target/release/bundle/macos/Axonkey.app

build:
	ENV_FILE="$(ENV_FILE)" node ./scripts/build.mjs

release:
	ENV_FILE="$(ENV_FILE)" node ./scripts/release.mjs "$(V)" "$(RC)"

version-check:
	node ./scripts/repo-version.mjs check --env-file "$(ENV_FILE)"

build-macos: version-check
	node ./scripts/build-macos.mjs

build-macos-audio:
	./scripts/build-macos-audio-package.sh

build-uninstall-old-driver:
	npm run build:uninstall-old-driver

check-uninstall-old-driver-git:
	npm run check:uninstall-old-driver-git

test-release:
	npm run test:release

uninstall-driver:
	./vendor/QuarborUniversalKeyboardDriverInstaller/QuarborUniversalKeyboardDriverInstaller.exe --uninstall "$(DEVICE)"

# Agent CLI helpers. `make cli ARGS='capabilities --json'` is the escape hatch
# for commands that do not have a dedicated target below.
cli-build:
	cargo build --manifest-path src-tauri/Cargo.toml --bin axonkey-cli

cli-build-release:
	cargo build --manifest-path src-tauri/Cargo.toml --release --bin axonkey-cli

cli: cli-build
	$(if $(strip $(ARGS)),,$(error ARGS is required; e.g. make cli ARGS='capabilities --json'))
	$(CLI_BIN) $(ARGS)

cli-capabilities: cli-build
	$(CLI_BIN) capabilities --json

cli-status: cli-build
	$(CLI_BIN) status --json

cli-device-list: cli-build
	$(CLI_BIN) device list --json

cli-profile-list: cli-build
	$(CLI_BIN) profile list $(CLI_DEVICE_ARGS) --json

cli-profile-create: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(NAME)),,$(error INSTANCE or DEVICE, and NAME are required))
	$(CLI_BIN) profile create $(CLI_DEVICE_ARGS) --name "$(NAME)" $(if $(DRY_RUN),--dry-run) --json

cli-profile-activate: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(PROFILE)),,$(error INSTANCE or DEVICE, and PROFILE are required))
	$(CLI_BIN) profile activate $(CLI_DEVICE_ARGS) --profile "$(PROFILE)" $(if $(DRY_RUN),--dry-run) --json

cli-keymap: cli-build
	$(CLI_BIN) keymap get $(CLI_DEVICE_ARGS) $(if $(PROFILE),--profile "$(PROFILE)",) --json

cli-mapping-list: cli-build
	$(CLI_BIN) mapping list $(CLI_DEVICE_ARGS) $(if $(PROFILE),--profile "$(PROFILE)",) --json

cli-mapping-get: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(BUTTON),$(TRIGGER)),,$(error INSTANCE or DEVICE, BUTTON and TRIGGER are required; e.g. make cli-mapping-get DEVICE=rc003 BUTTON=voice TRIGGER=click))
	$(CLI_BIN) mapping get $(CLI_TARGET_ARGS) --json

cli-shortcut-dry-run: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(BUTTON),$(TRIGGER),$(KEYS)),,$(error INSTANCE or DEVICE, BUTTON, TRIGGER and KEYS are required; e.g. make cli-shortcut-dry-run DEVICE=rc003 BUTTON=voice TRIGGER=click KEYS='Mod+Shift+P'))
	$(CLI_BIN) shortcut set $(CLI_TARGET_ARGS) --keys "$(KEYS)" --dry-run --json

cli-shortcut-set: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(BUTTON),$(TRIGGER),$(KEYS)),,$(error INSTANCE or DEVICE, BUTTON, TRIGGER and KEYS are required; e.g. make cli-shortcut-set DEVICE=rc003 BUTTON=voice TRIGGER=click KEYS='Mod+Shift+P'))
	$(CLI_BIN) shortcut set $(CLI_TARGET_ARGS) --keys "$(KEYS)" --json

# `SEQUENCE` or `ACTIONS` is a JSON array. The runner keeps it out of the
# Windows shell command line so PowerShell and Git Bash use the same target.
cli-mapping-dry-run: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(BUTTON),$(TRIGGER),$(or $(SEQUENCE),$(ACTIONS))),,$(error INSTANCE or DEVICE, BUTTON, TRIGGER and SEQUENCE or ACTIONS are required))
	node ./scripts/run-cli.mjs mapping set $(CLI_TARGET_ARGS) --sequence-from-env --dry-run --json

cli-mapping-set: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(BUTTON),$(TRIGGER),$(or $(SEQUENCE),$(ACTIONS))),,$(error INSTANCE or DEVICE, BUTTON, TRIGGER and SEQUENCE or ACTIONS are required))
	node ./scripts/run-cli.mjs mapping set $(CLI_TARGET_ARGS) --sequence-from-env --json

cli-mapping-clear: cli-build
	$(if $(and $(or $(INSTANCE),$(DEVICE)),$(BUTTON),$(TRIGGER)),,$(error INSTANCE or DEVICE, BUTTON and TRIGGER are required; e.g. make cli-mapping-clear DEVICE=rc003 BUTTON=voice TRIGGER=click))
	$(CLI_BIN) mapping clear $(CLI_TARGET_ARGS) --yes --json

test-cli: cli-build
	cargo test --manifest-path src-tauri/Cargo.toml --bin axonkey-cli
	node --test test/cli-contract.test.mjs test/instance-cli.test.mjs test/text-path-behavior.test.mjs

help:
	@echo "CLI:"
	@echo "  make cli-capabilities"
	@echo "  make cli-status"
	@echo "  make cli-device-list"
	@echo "  make cli-profile-list INSTANCE=<id>"
	@echo '  make cli-profile-create INSTANCE=<id> NAME="鼠标操作"'
	@echo '  make cli-profile-activate INSTANCE=<id> PROFILE="鼠标操作"'
	@echo "  INSTANCE=<id> can replace DEVICE=<kind> in keymap and mapping targets"
	@echo "  make cli-keymap DEVICE=rc003"
	@echo "  make cli ARGS='capabilities --json'"
	@echo "  make cli-mapping-list DEVICE=rc003"
	@echo "  make cli-mapping-get DEVICE=rc003 BUTTON=voice TRIGGER=click"
	@echo "  make cli-shortcut-dry-run DEVICE=rc003 BUTTON=voice TRIGGER=click KEYS='Mod+Shift+P'"
	@echo "  make cli-shortcut-set DEVICE=rc003 BUTTON=voice TRIGGER=click KEYS='Mod+Shift+P'"
	@echo "  make cli-mapping-dry-run DEVICE=rc003 BUTTON=voice TRIGGER=click SEQUENCE='[...]'"
	@echo "  make cli-mapping-set DEVICE=rc003 BUTTON=voice TRIGGER=click SEQUENCE='[...]'"
	@echo "  make cli-mapping-clear DEVICE=rc003 BUTTON=voice TRIGGER=click"
