// Copyright (c) 2025 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

#pragma once

#include <CLI/CLI.hpp>
#include <tuple>
#include "constants.hpp"
#include "utils.hpp"


namespace hy {


constexpr auto DEFAULT_MAX_INTERCEPTION_DEVICES = 20;
constexpr auto DEFAULT_KEYBOARD_SYMLINKS        = 1000;
constexpr auto DEFAULT_POINTER_SYMLINKS         = 1000;


struct AppMainConfig {
    bool verbose;
    bool lockdown;
    int n_max_interception_devices;
    int n_keyboard_symlinks;
    int n_pointer_symlinks;
};


struct AppInstallServiceConfig {
    AppMainConfig main_cfg;
    bool verbose;
};


struct AppUninstallServiceConfig {
    AppMainConfig main_cfg;
    bool verbose;
};


inline auto parse_cli(int argc, wchar_t** argv) {
    AppMainConfig             main_cfg              = {};
    AppInstallServiceConfig   install_service_cfg   = {};
    AppUninstallServiceConfig uninstall_service_cfg = {};
    auto app = std::make_unique<CLI::App>();
    app->require_subcommand(-1);
    auto install_service_subcommand   = app->add_subcommand("install-service",   "");
    auto uninstall_service_subcommand = app->add_subcommand("uninstall-service", "");
    app->set_help_all_flag("--help-all", "Show help for all subcommands.");

    main_cfg.n_max_interception_devices = DEFAULT_MAX_INTERCEPTION_DEVICES;
    main_cfg.n_keyboard_symlinks        = DEFAULT_KEYBOARD_SYMLINKS;
    main_cfg.n_pointer_symlinks         = DEFAULT_POINTER_SYMLINKS;

    app->add_flag("-v, --verbose",                main_cfg.verbose,                    "");
    app->add_flag("--lockdown",                   main_cfg.lockdown,                   "Restrict \\Device\\Interception* access to SYSTEM and Administrators only");
    app->add_option("--max-interception-devices", main_cfg.n_max_interception_devices, "")->capture_default_str();
    app->add_option("--keyboard-symlinks",        main_cfg.n_keyboard_symlinks,        "")->capture_default_str();
    app->add_option("--pointer-symlinks",         main_cfg.n_pointer_symlinks,         "")->capture_default_str();

    install_service_subcommand->add_flag("-v, --verbose", install_service_cfg.verbose, "");

    uninstall_service_subcommand->add_flag("-v, --verbose", uninstall_service_cfg.verbose, "");

    auto cfg_file_path = (std::filesystem::path(get_program_data_folder()) / MY_DATA_DIR_NAME / MY_CFG_INI_NAME).lexically_normal();
    app->config_formatter(std::make_shared<CLI::ConfigINI>());
    app->set_config("--config", cfg_file_path.string(), "", true);
        // ->multi_option_policy(CLI::MultiOptionPolicy::Throw)
        // ->expected(0, 1)

    // TODO: undo subcommand

    try {
        app->parse(argc, argv);
    } catch (const CLI::ParseError& e) {
        std::exit(app->exit(e));
    }

    install_service_cfg.main_cfg   = main_cfg;
    uninstall_service_cfg.main_cfg = main_cfg;

    return std::tuple(std::move(app), main_cfg, install_service_cfg, uninstall_service_cfg);
}


}  // namespace


// ..\interception_driver_fix> .\test.exe -v uninstall-service --help-all
// The following argument was not expected: --help-all
// Run with --help or --help-all for more information.
// ^ Confusing. TODO: Fix.
