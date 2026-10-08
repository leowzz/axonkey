// Copyright (c) 2025 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

#pragma once

#include <hy_windows.h>
#include <filesystem>
#include <spdlog/spdlog.h>
#include <sr/scope.h>
#include "constants.hpp"
#include "utils.hpp"
#include "mutex_utils.hpp"


namespace hy {


inline std::wstring get_current_executable() {
    auto exe_file = std::wstring(260, L'\0');
    auto size = GetModuleFileNameW(nullptr, exe_file.data(), exe_file.size());
    if (size == 0 || size >= exe_file.size()) {
        // 32767: Theoretical maximum number of wchar_t's for a UNICODE_STRING
        // +1 is not for null termination, but so we can differentiate between a 32767 long string from a truncated string.
        exe_file.resize(32767+1);
        size = GetModuleFileNameW(nullptr, exe_file.data(), exe_file.size());
        if (size == 0 || size >= exe_file.size()) {
            throw std::runtime_error("GetModuleFileNameW error.");
        }
    }
    exe_file.resize(size);

    return exe_file;
}


inline void uninstall_service() {
    spdlog::info("Uninstalling service.");

    auto hSCM = sr::make_unique_resource_checked(
        OpenSCManagerW(
            nullptr,
            nullptr,
            DELETE
        ),
        nullptr,
        CloseServiceHandle
    );
    if (!hSCM.get()) {
        throw std::runtime_error("OpenSCManagerW error (uninstall).");
    }

    auto hService = sr::make_unique_resource_checked(
        OpenServiceW(
            hSCM.get(),
            widen(MY_SERVICE_NAME).data(),
            SC_MANAGER_ALL_ACCESS
        ),
        nullptr,
        CloseServiceHandle
    );
    if (!hService.get()) {
        if (GetLastError() == ERROR_SERVICE_DOES_NOT_EXIST) {
            return;  // The service has already been uninstalled.
        }
        throw std::runtime_error("OpenServiceW error.");
    }

    SERVICE_STATUS serviceStatus = {};
    if(!ControlService(
        hService.get(),
        SERVICE_CONTROL_STOP,
        &serviceStatus
    )) {
        if (GetLastError() != ERROR_SERVICE_NOT_ACTIVE) {
            throw std::runtime_error("ControlService error.");
        }
    }

    if(!DeleteService(hService.get())) {
        throw std::runtime_error("DeleteService error.");
    }

    spdlog::info("Uninstalled service successfully.");
}


inline void install_service() {
    spdlog::info("Installing service.");

    auto hSCM = sr::make_unique_resource_checked(
        OpenSCManagerW(
            nullptr,
            nullptr,
            SC_MANAGER_CREATE_SERVICE
        ),
        nullptr,
        CloseServiceHandle
    );
    if (!hSCM.get()) {
        throw std::runtime_error("OpenSCManagerW error (install).");
    }

    auto hService = sr::make_unique_resource_checked(
        CreateServiceW(
            hSCM.get(),
            widen(MY_SERVICE_NAME).data(),
            widen(MY_SERVICE_DISPLAY_NAME).data(),
            SC_MANAGER_ALL_ACCESS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,  // SERVICE_DEMAND_START,
            SERVICE_ERROR_NORMAL,
            get_current_executable().c_str(),  // dst.wstring().c_str(),
            nullptr,
            nullptr,
            nullptr,
            nullptr,
            nullptr
        ),
        nullptr,
        CloseServiceHandle
    );
    if (!hService.get()) {
        throw std::runtime_error("CreateServiceW error.");
    }

    auto w_service_description = widen(MY_SERVICE_DESCRIPTION);
    SERVICE_DESCRIPTIONW serviceDescription = {};
    serviceDescription.lpDescription = w_service_description.data();

    if (!ChangeServiceConfig2W(
        hService.get(),
        SERVICE_CONFIG_DESCRIPTION,
        &serviceDescription
    )) {
        throw std::runtime_error("ChangeServiceConfig2W error (description).");
    }

    SERVICE_REQUIRED_PRIVILEGES_INFOW servicePrivileges = {};
    // This function fails open silently if any incorrectly named privileges are set, so beware.
    //   It fails open as if no required privileges were requested, which ends up allowing all privileges.
    servicePrivileges.pmszRequiredPrivileges = const_cast<LPWSTR>(L"SeCreatePermanentPrivilege\0");

    if (!ChangeServiceConfig2W(
        hService.get(),
        SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO,
        &servicePrivileges
    )) {
        throw std::runtime_error("ChangeServiceConfig2W error (privileges).");
    }

    if (!StartServiceW(
        hService.get(),
        0,
        nullptr
    )) {
        throw std::runtime_error("StartServiceW error.");
    }

    spdlog::info("Installed service successfully.");
}


}  // namespace
