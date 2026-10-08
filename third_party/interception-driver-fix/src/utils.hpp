// Copyright (c) 2025 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

#pragma once

#include <hy_windows.h>
#include <phnt.h>
#include <shlobj.h>
#include <knownfolders.h>
#include <iostream>
#include <filesystem>
#include <source_location>
#include <algorithm>
#include <cmath>
#include <stdexcept>




namespace hy {


inline std::string narrow(std::wstring_view wsv);


inline std::wstring widen(std::string_view sv) {
    if (sv.empty()) {
        return L"";
    }

    int size_needed = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS,
        sv.data(), sv.size(),
        nullptr, 0
    );

    if (size_needed == 0) {
        throw std::runtime_error("widen failed.");
    }

    std::wstring widened_str(size_needed, L'\0');
    MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS,
        sv.data(), sv.size(),
        &widened_str[0], size_needed
    );
    widened_str.resize(size_needed);

    return widened_str;
}


inline std::string narrow(std::wstring_view wsv) {
    if (wsv.empty()) {
        return "";
    }

    int size_needed = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS,
        wsv.data(), wsv.size(),
        nullptr, 0,
        nullptr, nullptr
    );

    if (size_needed == 0) {
        throw std::runtime_error("narrow failed.");
    }

    std::string narrowed_str(size_needed, '\0');
    WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS,
        wsv.data(), wsv.size(),
        &narrowed_str[0], size_needed,
        nullptr, nullptr
    );
    narrowed_str.resize(size_needed);

    return narrowed_str;
}


inline size_t get_os_pointer_size() {
    SYSTEM_INFO si;
    GetNativeSystemInfo(&si);
    size_t osPointerSize = sizeof (void*);

    switch(si.wProcessorArchitecture) {
        case PROCESSOR_ARCHITECTURE_AMD64:
        case PROCESSOR_ARCHITECTURE_ARM64:
        case PROCESSOR_ARCHITECTURE_IA64:
            osPointerSize = 8;
            break;
        case PROCESSOR_ARCHITECTURE_INTEL:
        case PROCESSOR_ARCHITECTURE_ARM:
            osPointerSize = 4;
            break;
    }

    return osPointerSize;
}


inline int aligned_to(int value, int alignment_value) {
    return alignment_value * (int)std::ceil((double)value / (double)alignment_value);
}


inline bool is_path_relative_to(const std::filesystem::path& target, const std::filesystem::path& base) {
    auto target_it = target.wstring();
    auto base_it = base.wstring();

    auto mismatch_pair = std::mismatch(base_it.begin(), base_it.end(), target_it.begin(),
        [](WCHAR a, WCHAR b) {
            return RtlUpcaseUnicodeChar(a) == RtlUpcaseUnicodeChar(b);
        }
    );

    if (mismatch_pair.first == base_it.end()) {
        if (mismatch_pair.second == target_it.end() || *mismatch_pair.second == '\\') {
            return true;
        }
    }
    return false;
}


std::string get_program_data_folder() {
    HRESULT hr;
    PWSTR raw_path = nullptr;
    hr = SHGetKnownFolderPath(
        FOLDERID_ProgramData,
        0,
        nullptr,
        &raw_path
    );
    if (FAILED(hr)) {
        throw std::runtime_error("SHGetKnownFolderPath error.");
    }
    auto path = narrow(raw_path);
    CoTaskMemFree(raw_path);

    return path;
}


}  // namespace
