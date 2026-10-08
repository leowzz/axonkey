// Copyright (c) 2025 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

#pragma once

#include <hy_windows.h>
#include <iostream>
#include <sddl.h>
#include <combaseapi.h>


namespace hy {


inline std::wstring get_guid() {
    GUID g;
    if (CoCreateGuid(&g)) {
        throw std::runtime_error("");
    }

    std::wstring guid_buffer;
    guid_buffer.resize(38);

    int n = StringFromGUID2(g, guid_buffer.data(), guid_buffer.size()+1);
    if (n != guid_buffer.size()+1) {
        throw std::runtime_error("");
    }

    for (auto& c : guid_buffer) {
        c = towlower(c);
    }

    return guid_buffer.substr(1, guid_buffer.size()-1-1);
}


inline std::wstring get_mutex_name(HKEY root_key, std::wstring stable_key_name, std::wstring volatile_key_name) {
    constexpr auto sddl = L"D:(A;;FA;;;SY)(A;;FA;;;BA)";  // HARDCODED

    PSECURITY_DESCRIPTOR psd;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl,
        SDDL_REVISION_1,
        &psd,
        nullptr
    )) {
        throw std::runtime_error("");
    }

    std::wstring mutex_name = L"Global\\" + get_guid();

    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = false;
    sa.lpSecurityDescriptor = psd;

    HKEY stable_key = nullptr;
    if (RegCreateKeyExW(
        root_key,
        stable_key_name.c_str(),
        0,
        nullptr,
        0,
        KEY_ALL_ACCESS,
        nullptr,
        &stable_key,
        nullptr
    )) {
        throw std::runtime_error("");
    }
    HKEY key = nullptr;
    DWORD disposition;
    if (RegCreateKeyExW(
        stable_key,
        volatile_key_name.c_str(),
        0,
        mutex_name.data(),
        REG_OPTION_VOLATILE,
        KEY_ALL_ACCESS,
        &sa,
        &key,
        &disposition
    )) {
        throw std::runtime_error("");
    }
    if (RegCloseKey(stable_key)) { throw std::runtime_error(""); }
    if (disposition != REG_CREATED_NEW_KEY) {
        mutex_name.resize(MAX_PATH);
        DWORD mutex_name_size = mutex_name.size()+1;
        if (RegQueryInfoKeyW(key, mutex_name.data(), &mutex_name_size, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr)) {
            throw std::runtime_error("");
        }
        mutex_name.resize(mutex_name_size);
    }

    return mutex_name;
}


inline HANDLE wait_for_mutex_creation(std::wstring mutex_name, bool inherit, int timeout) {
    int time_elapsed = 0;
    int polling_interval = 100;

    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = inherit;
    sa.lpSecurityDescriptor = nullptr;

    while (true) {
        HANDLE hMutex = CreateMutexW(&sa, false, mutex_name.c_str());
        if (!hMutex) {
            return nullptr;
        }

        if (GetLastError() == ERROR_SUCCESS) {
            return hMutex;
        }

        CloseHandle(hMutex);

        if (time_elapsed >= timeout) {
            return nullptr;
        }

        Sleep(polling_interval);
        time_elapsed += polling_interval;
    }
}


}  // namespace
