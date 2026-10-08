// Copyright (c) 2025 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

#pragma once

#include <hy_windows.h>
#include <spdlog/spdlog.h>
#include "cli.hpp"
#include "core.hpp"


namespace hy {


struct SERVICE_CONTEXT {
    SERVICE_STATUS_HANDLE hStatus;
    SERVICE_STATUS status;
};


inline DWORD WINAPI ServiceHandler(
    DWORD    dwControl,
    DWORD    dwEventType,
    LPVOID   lpEventData,
    LPVOID   lpContext
) {
    auto& ctx = *static_cast<SERVICE_CONTEXT*>(lpContext);

    switch(dwControl) {
        case SERVICE_CONTROL_INTERROGATE:
            return NO_ERROR;
            break;
    }

    return ERROR_CALL_NOT_IMPLEMENTED;
}


inline VOID WINAPI ServiceMain(int argc, wchar_t** argv) {
    SERVICE_CONTEXT ctx = {};
    SERVICE_STATUS_HANDLE hServiceStatus = RegisterServiceCtrlHandlerExW(
        nullptr,
        ServiceHandler,
        &ctx
    );

    SERVICE_STATUS serviceStatus = {};
    serviceStatus.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    serviceStatus.dwServiceSpecificExitCode = 0;
    serviceStatus.dwWin32ExitCode = 1;
    serviceStatus.dwControlsAccepted = 0;
    serviceStatus.dwCurrentState = SERVICE_START_PENDING;
    serviceStatus.dwCheckPoint = 0;
    serviceStatus.dwWaitHint = 0;

    try {
        if (!SetServiceStatus(hServiceStatus, &serviceStatus)) { throw std::runtime_error("SetServiceStatus error (start pending)."); }

        serviceStatus.dwCurrentState = SERVICE_RUNNING;
        if (!SetServiceStatus(hServiceStatus, &serviceStatus)) { throw std::runtime_error("SetServiceStatus error (running)."); }

        auto [app, main_cfg, install_service_cfg, uninstall_service_cfg] = parse_cli(argc, argv);

        if (app->got_subcommand("install-service")) {
            throw std::runtime_error("Unexpected arguments for service.");
        }
        if (app->got_subcommand("uninstall-service")) {
            throw std::runtime_error("Unexpected arguments for service.");
        }

        spdlog::set_level(spdlog::level::info);
        if (main_cfg.verbose) {
            spdlog::set_level(spdlog::level::debug);
        }

        serviceStatus.dwWin32ExitCode = real_main(main_cfg);

        Sleep(3000);  // services.msc UI/UX improvement, so that there's no jarring pop-up when starting this manually.
    } catch (const std::exception& e) {
        spdlog::error("Exception: {}", e.what());
    } catch (...) {
        spdlog::error("Unknown error.");
    }

    serviceStatus.dwCurrentState = SERVICE_STOPPED;
    if (!SetServiceStatus(hServiceStatus, &serviceStatus)) {
        spdlog::critical("Failed to set SERVICE_STOPPED status.");
    }
}


}  // namespace
