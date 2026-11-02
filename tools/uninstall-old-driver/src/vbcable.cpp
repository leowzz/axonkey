#include <windows.h>
#include <setupapi.h>
#include <newdev.h>
#include <shlobj.h>

#include "vbcable.h"
#include "audio_service_pause.h"

#include <array>
#include <algorithm>
#include <cwchar>
#include <stdexcept>
#include <system_error>

namespace fs = std::filesystem;

namespace vbcable {
namespace {

constexpr wchar_t kHardwareId[] = L"VBAudioVACWDM";
constexpr wchar_t kService[] = L"VBAudioVACMME";
constexpr const wchar_t* kDriverFiles[] = {
    L"vbaudio_cable_xp.sys", L"vbaudio_cable_2003.sys", L"vbaudio_cable_vista.sys", L"vbaudio_cable_win7.sys",
    L"vbaudio_cable64_2003.sys", L"vbaudio_cable64_vista.sys", L"vbaudio_cable64_win7.sys",
    L"vbaudio_cable64_win10.sys", L"vbaudio_cable64arm_win10.sys",
};
constexpr const wchar_t* kMediaCategories[] = {
    L"{B961F7FC-8C2D-4378-9DA3-5A3A89511B74}",
    L"{B961F7FD-8C2D-4378-9DA3-5A3A89511B74}",
    L"{B961F7FD-8C2D-4378-9DA3-5A3A89511B75}",
    L"{23208800-570C-4682-BB53-7F12CE497910}",
    L"{23208900-570C-4682-BB53-7F12CE497910}",
};

void fail(const char* operation, DWORD error = GetLastError()) {
    throw std::system_error(static_cast<int>(error), std::system_category(), operation);
}

struct DeviceSet {
    HDEVINFO handle;
    ~DeviceSet() { SetupDiDestroyDeviceInfoList(handle); }
};

bool matchesDevice(HDEVINFO set, SP_DEVINFO_DATA& info) {
    DWORD bytes = 0;
    SetupDiGetDeviceRegistryPropertyW(set, &info, SPDRP_HARDWAREID, nullptr, nullptr, 0, &bytes);
    const auto error = GetLastError();
    if (error == ERROR_INVALID_DATA) return false;
    if (error != ERROR_INSUFFICIENT_BUFFER) fail("Read device hardware ID", error);
    std::vector<wchar_t> ids(bytes / sizeof(wchar_t) + 2, L'\0');
    if (!SetupDiGetDeviceRegistryPropertyW(set, &info, SPDRP_HARDWAREID, nullptr,
            reinterpret_cast<BYTE*>(ids.data()), bytes, nullptr)) fail("Read device hardware ID");
    for (const wchar_t* id = ids.data(); *id; id += wcslen(id) + 1) {
        if (_wcsicmp(id, kHardwareId) == 0) return true;
    }
    return false;
}

bool matchesPackage(const fs::path& path) {
    const HINF inf = SetupOpenInfFileW(path.c_str(), nullptr, INF_STYLE_WIN4, nullptr);
    if (inf == INVALID_HANDLE_VALUE) {
        const auto error = GetLastError();
        if (error == ERROR_ACCESS_DENIED || error == ERROR_SHARING_VIOLATION) fail("Read OEM INF", error);
        return false;
    }
    INFCONTEXT context{};
    wchar_t hardware[256]{}, service[256]{};
    const bool matches = SetupFindFirstLineW(inf, L"Strings", L"HardwareId", &context) &&
        SetupGetStringFieldW(&context, 1, hardware, 256, nullptr) &&
        _wcsicmp(hardware, kHardwareId) == 0 &&
        SetupFindFirstLineW(inf, L"Strings", L"ServiceName", &context) &&
        SetupGetStringFieldW(&context, 1, service, 256, nullptr) &&
        _wcsicmp(service, kService) == 0;
    SetupCloseInfFile(inf);
    return matches;
}

bool isOemInf(const fs::path& path) {
    const auto name = path.filename().wstring();
    if (name.size() < 8 || _wcsnicmp(name.c_str(), L"oem", 3) != 0 ||
        _wcsicmp(name.c_str() + name.size() - 4, L".inf") != 0) return false;
    return name.find_first_not_of(L"0123456789", 3) == name.size() - 4;
}

void recordError(Result& result, const std::function<void(const std::wstring&)>& log,
                 const std::wstring& operation, DWORD error) {
    wchar_t* message = nullptr;
    FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, error, 0, reinterpret_cast<wchar_t*>(&message), 0, nullptr);
    std::wstring text = operation + L" (" + std::to_wstring(error) + L"): " + (message ? message : L"Windows error");
    if (message) LocalFree(message);
    while (!text.empty() && (text.back() == L'\r' || text.back() == L'\n')) text.pop_back();
    result.errors.push_back(text);
    log(L"ERROR: " + text);
}

struct ServiceHandle {
    SC_HANDLE handle;
    ~ServiceHandle() { if (handle) CloseServiceHandle(handle); }
};

class AudioServices {
public:
    explicit AudioServices(const std::function<void(const std::wstring&)>& log)
        : manager_{OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT)}, log_(log) {
        if (!manager_.handle) fail("Open audio service manager");
    }

    DWORD state(const std::wstring& name) {
        log_(L"Checking audio service state: " + name);
        ServiceHandle service{open(name, SERVICE_QUERY_STATUS)};
        return settledState(service.handle);
    }

    std::vector<std::wstring> dependents(const std::wstring& name) {
        ServiceHandle service{open(name, SERVICE_ENUMERATE_DEPENDENTS)};
        DWORD bytes = 0, count = 0;
        if (EnumDependentServicesW(service.handle, SERVICE_ACTIVE, nullptr, 0, &bytes, &count)) return {};
        if (GetLastError() != ERROR_MORE_DATA) fail("Enumerate audio dependent services");
        std::vector<BYTE> buffer(bytes);
        if (!EnumDependentServicesW(service.handle, SERVICE_ACTIVE,
                reinterpret_cast<ENUM_SERVICE_STATUSW*>(buffer.data()), bytes, &bytes, &count)) {
            fail("Enumerate audio dependent services");
        }
        const auto entries = reinterpret_cast<const ENUM_SERVICE_STATUSW*>(buffer.data());
        std::vector<std::wstring> names;
        for (DWORD i = 0; i < count; ++i) names.emplace_back(entries[i].lpServiceName);
        return names;
    }

    void stop(const std::wstring& name) {
        log_(L"Stopping audio service: " + name);
        ServiceHandle service{open(name, SERVICE_QUERY_STATUS | SERVICE_STOP)};
        SERVICE_STATUS status{};
        if (!ControlService(service.handle, SERVICE_CONTROL_STOP, &status)) fail("Stop audio service");
        if (settledState(service.handle) != SERVICE_STOPPED) fail("Wait for audio service to stop", ERROR_SERVICE_REQUEST_TIMEOUT);
        log_(L"Stopped audio service: " + name);
    }

    void restore(const std::wstring& name, DWORD original) {
        log_(L"Restoring audio service: " + name);
        ServiceHandle service{open(name, SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_PAUSE_CONTINUE)};
        auto current = settledState(service.handle);
        if (current == original) return;
        if (current == SERVICE_STOPPED) {
            if (!StartServiceW(service.handle, 0, nullptr)) fail("Restart audio service");
            current = settledState(service.handle);
            if (current != SERVICE_RUNNING) fail("Wait for audio service to restart", ERROR_SERVICE_REQUEST_TIMEOUT);
        }
        if (current != original) {
            SERVICE_STATUS status{};
            if (!ControlService(service.handle, original == SERVICE_PAUSED ? SERVICE_CONTROL_PAUSE : SERVICE_CONTROL_CONTINUE, &status)) {
                fail("Restore audio service state");
            }
            if (settledState(service.handle) != original) fail("Wait for original audio service state", ERROR_SERVICE_REQUEST_TIMEOUT);
        }
        log_(L"Restored audio service: " + name);
    }

private:
    SC_HANDLE open(const std::wstring& name, DWORD access) {
        const auto service = OpenServiceW(manager_.handle, name.c_str(), access);
        if (!service) fail("Open audio service");
        return service;
    }

    DWORD settledState(SC_HANDLE service) {
        const auto deadline = GetTickCount64() + 30000;
        for (;;) {
            SERVICE_STATUS status{};
            if (!QueryServiceStatus(service, &status)) fail("Query audio service status");
            switch (status.dwCurrentState) {
            case SERVICE_START_PENDING:
            case SERVICE_STOP_PENDING:
            case SERVICE_CONTINUE_PENDING:
            case SERVICE_PAUSE_PENDING:
                if (GetTickCount64() >= deadline) fail("Wait for audio service state", ERROR_SERVICE_REQUEST_TIMEOUT);
                Sleep(100);
                break;
            default:
                return status.dwCurrentState;
            }
        }
    }

    ServiceHandle manager_;
    const std::function<void(const std::wstring&)>& log_;
};

void removeDevices(const Plan& plan, Result& result, const std::function<void(const std::wstring&)>& log) {
    DeviceSet set{SetupDiCreateDeviceInfoList(nullptr, nullptr)};
    if (set.handle == INVALID_HANDLE_VALUE) { recordError(result, log, L"Open device list", GetLastError()); return; }
    for (const auto& id : plan.devices) {
        SP_DEVINFO_DATA info{sizeof(info)};
        if (!SetupDiOpenDeviceInfoW(set.handle, id.c_str(), nullptr, 0, &info)) {
            recordError(result, log, L"Open device " + id, GetLastError()); continue;
        }
        BOOL reboot = FALSE;
        // DiUninstallDevice also removes child endpoints, including disconnected children on Windows 8+.
        if (!DiUninstallDevice(nullptr, set.handle, &info, 0, &reboot)) {
            recordError(result, log, L"Remove device " + id, GetLastError());
        } else {
            ++result.devicesRemoved;
            log(L"Removed device " + id);
        }
        result.rebootRequired |= reboot != FALSE;
    }
}

void removeService(Result& result, const std::function<void(const std::wstring&)>& log) {
    const SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!manager) { recordError(result, log, L"Open service manager", GetLastError()); return; }
    const SC_HANDLE service = OpenServiceW(manager, kService, SERVICE_QUERY_STATUS | SERVICE_STOP | DELETE);
    if (!service) {
        const auto error = GetLastError();
        if (error == ERROR_SERVICE_MARKED_FOR_DELETE) result.rebootRequired = true;
        else if (error != ERROR_SERVICE_DOES_NOT_EXIST) recordError(result, log, L"Open VBAudioVACMME service", error);
        CloseServiceHandle(manager);
        return;
    }
    SERVICE_STATUS status{};
    if (!QueryServiceStatus(service, &status)) {
        recordError(result, log, L"Query VBAudioVACMME service", GetLastError());
    } else if (status.dwCurrentState != SERVICE_STOPPED) {
        if (!ControlService(service, SERVICE_CONTROL_STOP, &status)) {
            const auto error = GetLastError();
            if (error == ERROR_INVALID_SERVICE_CONTROL || error == ERROR_SERVICE_CANNOT_ACCEPT_CTRL) {
                result.rebootRequired = true;
            } else if (error != ERROR_SERVICE_NOT_ACTIVE) recordError(result, log, L"Stop VBAudioVACMME service", error);
        } else {
            const auto deadline = GetTickCount64() + 10000;
            while (status.dwCurrentState != SERVICE_STOPPED && GetTickCount64() < deadline) {
                Sleep(100);
                if (!QueryServiceStatus(service, &status)) {
                    recordError(result, log, L"Wait for VBAudioVACMME service", GetLastError()); break;
                }
            }
            if (status.dwCurrentState != SERVICE_STOPPED) result.rebootRequired = true;
        }
    }
    if (!DeleteService(service)) {
        const auto error = GetLastError();
        if (error == ERROR_SERVICE_MARKED_FOR_DELETE) result.rebootRequired = true;
        else recordError(result, log, L"Delete VBAudioVACMME service", error);
    } else {
        log(L"Deleted VBAudioVACMME service");
    }
    CloseServiceHandle(service);
    CloseServiceHandle(manager);
}

void removeRegistryKey(const std::wstring& path, REGSAM view, Result& result,
                       const std::function<void(const std::wstring&)>& log) {
    HKEY key = nullptr;
    auto error = RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.c_str(), 0, DELETE | KEY_ENUMERATE_SUB_KEYS | KEY_QUERY_VALUE | KEY_SET_VALUE | view, &key);
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return;
    if (error == ERROR_SUCCESS) {
        error = RegDeleteTreeW(key, nullptr);
        RegCloseKey(key);
        if (error == ERROR_SUCCESS) error = RegDeleteKeyExW(HKEY_LOCAL_MACHINE, path.c_str(), view, 0);
    }
    if (error != ERROR_SUCCESS) recordError(result, log, L"Delete registry key " + path, error);
    else log(L"Deleted registry key " + path);
}

void removeFiles(const Plan& plan, Result& result, const std::function<void(const std::wstring&)>& log) {
    for (const auto& path : plan.files) {
        if (DeleteFileW(path.c_str())) { log(L"Deleted " + path.wstring()); continue; }
        const auto error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) continue;
        if (error == ERROR_SHARING_VIOLATION || error == ERROR_ACCESS_DENIED) {
            if (MoveFileExW(path.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT)) {
                result.rebootRequired = true;
                log(L"Scheduled deletion after restart: " + path.wstring());
                continue;
            }
            recordError(result, log, L"Schedule deletion " + path.wstring(), GetLastError());
        } else recordError(result, log, L"Delete " + path.wstring(), error);
    }
    for (const auto& path : plan.directories) {
        if (RemoveDirectoryW(path.c_str())) { log(L"Deleted directory " + path.wstring()); continue; }
        const auto error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) continue;
        if (MoveFileExW(path.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT)) {
            result.rebootRequired = true;
            log(L"Scheduled directory deletion after restart: " + path.wstring());
        } else recordError(result, log, L"Delete directory " + path.wstring(), GetLastError());
    }
}

void collectDirectory(Plan& plan, const fs::path& directory) {
    if (!fs::exists(directory)) return;
    if (fs::is_symlink(directory)) throw std::runtime_error("VB-CABLE directory is a link; remove it manually");
    plan.directories.push_back(directory);
    for (const auto& entry : fs::recursive_directory_iterator(directory)) {
        if (entry.is_directory() && !entry.is_symlink()) plan.directories.push_back(entry.path());
        else plan.files.push_back(entry.path());
    }
}

} // namespace

std::vector<std::wstring> findDevices() {
    // No DIGCF_PRESENT: old hidden device nodes must be removed as well.
    DeviceSet set{SetupDiGetClassDevsW(nullptr, nullptr, nullptr, DIGCF_ALLCLASSES)};
    if (set.handle == INVALID_HANDLE_VALUE) fail("Enumerate devices");
    std::vector<std::wstring> devices;
    for (DWORD index = 0; ; ++index) {
        SP_DEVINFO_DATA info{sizeof(info)};
        if (!SetupDiEnumDeviceInfo(set.handle, index, &info)) {
            if (GetLastError() == ERROR_NO_MORE_ITEMS) break;
            fail("Enumerate devices");
        }
        if (!matchesDevice(set.handle, info)) continue;
        DWORD length = 0;
        SetupDiGetDeviceInstanceIdW(set.handle, &info, nullptr, 0, &length);
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) fail("Read device instance ID");
        std::wstring id(length, L'\0');
        if (!SetupDiGetDeviceInstanceIdW(set.handle, &info, id.data(), length, nullptr)) fail("Read device instance ID");
        id.resize(length - 1);
        devices.push_back(std::move(id));
    }
    return devices;
}

std::vector<fs::path> findPackages(const fs::path& directory) {
    std::vector<fs::path> packages;
    for (const auto& file : fs::directory_iterator(directory)) {
        if (isOemInf(file.path()) && file.is_regular_file() && matchesPackage(file.path())) packages.push_back(file.path());
    }
    return packages;
}

Plan inspect(const fs::path& applicationDirectory) {
    std::array<wchar_t, MAX_PATH> windows{}, system{};
    if (!GetWindowsDirectoryW(windows.data(), static_cast<UINT>(windows.size()))) fail("Get Windows directory");
    if (!GetSystemDirectoryW(system.data(), static_cast<UINT>(system.size()))) fail("Get system directory");
    Plan plan;
    plan.devices = findDevices();
    plan.packages = findPackages(fs::path(windows.data()) / L"INF");
    for (const auto* name : kDriverFiles) {
        const auto path = fs::path(system.data()) / L"drivers" / name;
        if (fs::exists(path)) plan.files.push_back(path);
    }
    for (const auto& directory : {fs::path(system.data()), fs::path(windows.data()) / L"SysWOW64"}) {
        const auto panel = directory / L"VBCABLE_ControlPanel.exe";
        if (fs::exists(panel)) plan.files.push_back(panel);
    }
    for (const auto* folder : {&FOLDERID_ProgramFilesX64, &FOLDERID_ProgramFilesX86}) {
        wchar_t* programFiles = nullptr;
        const auto error = SHGetKnownFolderPath(*folder, KF_FLAG_DEFAULT, nullptr, &programFiles);
        if (FAILED(error)) fail("Get Program Files directory", static_cast<DWORD>(error));
        const auto directory = fs::path(programFiles) / L"VB" / L"CABLE";
        CoTaskMemFree(programFiles);
        // Only the standard install directory belongs to this product; never scan downloads or other VB products.
        collectDirectory(plan, directory);
    }
    collectDirectory(plan, applicationDirectory / L"vendor" / L"vbcable");
    // Queue directories after their contents, including when deletion is deferred until restart.
    std::sort(plan.directories.begin(), plan.directories.end(), [](const auto& a, const auto& b) {
        return a.native().size() > b.native().size();
    });
    return plan;
}

namespace {
void uninstallDriver(const Plan& plan, Result& result, const std::function<void(const std::wstring&)>& log) {
    removeDevices(plan, result, log);
    for (const auto& package : plan.packages) {
        BOOL reboot = FALSE;
        if (!DiUninstallDriverW(nullptr, package.c_str(), 0, &reboot)) {
            recordError(result, log, L"Uninstall package " + package.wstring(), GetLastError());
        } else {
            ++result.packagesRemoved;
            log(L"Removed package " + package.wstring());
        }
        result.rebootRequired |= reboot != FALSE;
    }
    // Keep package-owned files and settings intact if Windows rejected a device or package removal.
    if (!result.errors.empty()) return;
    removeService(result, log);
    removeFiles(plan, result, log);
    for (const auto* category : kMediaCategories) {
        removeRegistryKey(std::wstring(L"SYSTEM\\CurrentControlSet\\Control\\MediaCategories\\") + category, 0, result, log);
    }
    for (const REGSAM view : {KEY_WOW64_64KEY, KEY_WOW64_32KEY}) {
        removeRegistryKey(L"SOFTWARE\\VB-Audio\\Cable", view, result, log);
        removeRegistryKey(L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VB:VBCABLE {87459874-1236-4469}", view, result, log);
    }
}
} // namespace

Result uninstall(const Plan& plan, const std::function<void(const std::wstring&)>& log) {
    Result result;
    log(L"VB-CABLE cleanup started");
    const auto serviceError = [&](const std::system_error& error) {
        recordError(result, log, L"Windows audio service control", error.code().value());
    };
    try {
        AudioServices services(log);
        AudioServicePause pause(services, serviceError);
        pause.stop(L"Audiosrv");
        uninstallDriver(plan, result, log);
    } catch (const std::system_error& error) {
        serviceError(error);
    }
    log(result.errors.empty() ? L"VB-CABLE cleanup completed" : L"VB-CABLE cleanup completed with errors");
    return result;
}

} // namespace vbcable
