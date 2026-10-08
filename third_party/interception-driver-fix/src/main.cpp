// Copyright (c) 2025 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

#include <hy_windows.h>
#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include <spdlog/sinks/basic_file_sink.h>
#include "cli.hpp"
#include "core.hpp"
#include "service.hpp"



using namespace hy;


int wmain(int argc, wchar_t** argv) {
    try {
        auto log_path = (std::filesystem::path(get_program_data_folder()) / MY_DATA_DIR_NAME / "logs/interception-driver-fix.log").lexically_normal();
        // std::filesystem::create_directories(log_path.parent_path());

        std::vector<spdlog::sink_ptr> sinks;

        auto console_sink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
        sinks.emplace_back(console_sink);

        try {
            auto file_sink = std::make_shared<spdlog::sinks::basic_file_sink_mt>(log_path.string(), false);
            sinks.emplace_back(file_sink);
        } catch (const spdlog::spdlog_ex& e) {
            spdlog::error(e.what());
        }

        auto logger = std::make_shared<spdlog::logger>("main", sinks.begin(), sinks.end());
        spdlog::set_default_logger(logger);

        spdlog::info("Starting {} version {}.", MY_APP_NAME, MY_APP_VERSION);
        spdlog::info("Command line arguments: {}", narrow(GetCommandLineW()));

        auto [app, main_cfg, install_service_cfg, uninstall_service_cfg] = parse_cli(argc, argv);

        spdlog::set_level(spdlog::level::info);

        if (app->got_subcommand("install-service") || app->got_subcommand("uninstall-service")) {
            throw std::runtime_error("Use Axonkey interception-fix.ps1 to manage the service.");
        }

        if (main_cfg.verbose) {
            spdlog::set_level(spdlog::level::debug);
        }

        SERVICE_TABLE_ENTRYW service_table[] = {
            { const_cast<LPWSTR>(L""), reinterpret_cast<LPSERVICE_MAIN_FUNCTIONW>(ServiceMain) },
            { nullptr, nullptr }
        };

        if (StartServiceCtrlDispatcherW(service_table)) {
            return 0;
        }

        if (auto err = GetLastError(); err != ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
            throw std::runtime_error(fmt::format("StartServiceCtrlDispatcherW error ({}).", err));
        }

        throw std::runtime_error("Run only through the AxonkeyInterceptionFix Windows service.");
    } catch (const std::exception& e) {
        spdlog::error("Exception: {}", e.what());
        return 1;
    } catch (...) {
        spdlog::error("Unknown error.");
        return 1;
    }
}
