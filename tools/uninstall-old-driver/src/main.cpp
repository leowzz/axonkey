#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <winsvc.h>
#include <winreg.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
using namespace std::chrono_literals;

namespace {

constexpr wchar_t kFixService[] = L"AxonkeyInterceptionFix";
constexpr wchar_t kFixDirectory[] = L"C:\\Program Files\\Axonkey Interception Fix";
constexpr wchar_t kKeyboardClass[] = L"SYSTEM\\CurrentControlSet\\Control\\Class\\{4D36E96B-E325-11CE-BFC1-08002BE10318}";
constexpr wchar_t kMouseClass[] = L"SYSTEM\\CurrentControlSet\\Control\\Class\\{4D36E96F-E325-11CE-BFC1-08002BE10318}";
constexpr UINT_PTR kTimer = 1;
constexpr UINT kProgressMessage = WM_APP + 1;
constexpr DWORD kCommandTimeoutMs = 30'000;
constexpr DWORD kCleanupTimeoutMs = 180'000;

struct Options {
    bool confirmed = false;
    bool status = false;
    bool headless = false;
    bool autoClose = false;
    std::wstring logPath;
    bool autoStart() const { return confirmed || headless || !logPath.empty(); }
};

struct Components {
    bool interception = false;
    bool interceptionFix = false;
};

std::wstring lower(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(), towlower);
    return value;
}

std::wstring env(const wchar_t* name) {
    DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    GetEnvironmentVariableW(name, value.data(), size);
    value.resize(wcslen(value.c_str()));
    return value;
}

fs::path baseDir() {
    std::wstring value(32768, L'\0');
    DWORD length = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
    value.resize(length);
    return fs::path(value).parent_path().parent_path();
}

fs::path logPath(const Options& options) {
    if (!options.logPath.empty()) return fs::path(options.logPath);
    return fs::path(env(L"LOCALAPPDATA")) / L"Axonkey" / L"logs" / L"old-driver-uninstall.log";
}

std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(length, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
    return result;
}

void output(const std::string& value, DWORD handleKind) {
    HANDLE handle = GetStdHandle(handleKind);
    if (!handle || handle == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(handle, value.data(), static_cast<DWORD>(value.size()), &written, nullptr);
}

void printOut(const std::wstring& value) { output(utf8(value), STD_OUTPUT_HANDLE); }
void printErr(const std::wstring& value) { output(utf8(value), STD_ERROR_HANDLE); }

std::wstring jsonString(const fs::path& value) {
    std::wstring escaped = value.wstring();
    std::wstring result = L"\"";
    for (wchar_t c : escaped) {
        if (c == L'\\' || c == L'\"') result.push_back(L'\\');
        result.push_back(c);
    }
    result += L"\"";
    return result;
}

bool isAdministrator() {
    BOOL elevated = FALSE;
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    TOKEN_ELEVATION info{};
    DWORD size = 0;
    BOOL ok = GetTokenInformation(token, TokenElevation, &info, sizeof(info), &size);
    CloseHandle(token);
    elevated = ok && info.TokenIsElevated;
    return elevated == TRUE;
}

std::wstring quote(const std::wstring& value) {
    if (value.empty() || value.find_first_of(L" \t") != std::wstring::npos) return L"\"" + value + L"\"";
    return value;
}

int elevate(const Options& options) {
    wchar_t executable[MAX_PATH]{};
    GetModuleFileNameW(nullptr, executable, MAX_PATH);
    std::wstring parameters;
    if (options.confirmed) parameters += L" --confirmed";
    if (options.headless) parameters += L" --headless";
    if (options.autoClose) parameters += L" --auto-close";
    if (!options.logPath.empty()) parameters += L" --log-path " + quote(options.logPath);
    SHELLEXECUTEINFOW info{sizeof(info)};
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = L"runas";
    info.lpFile = executable;
    info.lpParameters = parameters.c_str();
    info.nShow = SW_SHOWNORMAL;
    if (!ShellExecuteExW(&info)) {
        if (GetLastError() == ERROR_CANCELLED) return 1223;
        return 1;
    }
    if (info.hProcess) {
        WaitForSingleObject(info.hProcess, INFINITE);
        DWORD code = 1;
        GetExitCodeProcess(info.hProcess, &code);
        CloseHandle(info.hProcess);
        return static_cast<int>(code);
    }
    return 0;
}

class Logger {
public:
    using Progress = std::function<void(const std::wstring&)>;
    Logger(const fs::path& path, Progress progress) : progress_(std::move(progress)) {
        std::error_code error;
        fs::create_directories(path.parent_path(), error);
        file_.open(path, std::ios::app);
    }
    bool good() const { return file_.good(); }
    void line(const std::wstring& message) {
        SYSTEMTIME now{};
        GetLocalTime(&now);
        file_ << L"[" << now.wYear << L"-" << now.wMonth << L"-" << now.wDay << L" "
              << now.wHour << L":" << now.wMinute << L":" << now.wSecond << L"] " << message << L"\n";
        file_.flush();
        if (progress_) progress_(localize(message));
    }
private:
    static std::wstring localize(const std::wstring& message) {
        if (message.starts_with(L"Stopping ")) return L"正在停止服务：" + message.substr(9);
        if (message.starts_with(L"Deleted ")) return L"已删除：" + message.substr(8);
        if (message.starts_with(L"Scheduled")) return L"已安排在重启后删除残留文件。";
        if (message.starts_with(L"ERROR:")) return L"卸载失败：" + message.substr(6);
        if (message.starts_with(L"WARNING:")) return L"提示：" + message.substr(8);
        if (message.starts_with(L"Old driver cleanup started")) return L"正在检查并卸载旧版输入组件…";
        if (message.starts_with(L"Old driver cleanup completed")) return L"卸载完成，请重启 Windows 使更改生效。";
        return L"正在处理：" + message;
    }
    std::wofstream file_;
    Progress progress_;
};

std::optional<std::vector<std::wstring>> readMultiString(const wchar_t* keyPath, const wchar_t* valueName) {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, keyPath, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) return std::nullopt;
    DWORD type = 0, bytes = 0;
    LONG result = RegQueryValueExW(key, valueName, nullptr, &type, nullptr, &bytes);
    if (result != ERROR_SUCCESS || (type != REG_MULTI_SZ && type != REG_SZ)) { RegCloseKey(key); return std::nullopt; }
    std::vector<BYTE> buffer(bytes + sizeof(wchar_t));
    result = RegQueryValueExW(key, valueName, nullptr, &type, buffer.data(), &bytes);
    RegCloseKey(key);
    if (result != ERROR_SUCCESS) return std::nullopt;
    std::vector<std::wstring> values;
    const wchar_t* text = reinterpret_cast<const wchar_t*>(buffer.data());
    for (const wchar_t* current = text; *current; current += wcslen(current) + 1) values.emplace_back(current);
    return values;
}

bool setMultiString(const wchar_t* keyPath, const wchar_t* valueName, const std::vector<std::wstring>& values) {
    HKEY key = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, keyPath, 0, KEY_SET_VALUE, &key) != ERROR_SUCCESS) return false;
    if (values.empty()) {
        LONG result = RegDeleteValueW(key, valueName);
        RegCloseKey(key);
        return result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND;
    }
    std::vector<wchar_t> encoded;
    for (const auto& value : values) { encoded.insert(encoded.end(), value.begin(), value.end()); encoded.push_back(L'\0'); }
    encoded.push_back(L'\0');
    LONG result = RegSetValueExW(key, valueName, 0, REG_MULTI_SZ, reinterpret_cast<const BYTE*>(encoded.data()), static_cast<DWORD>(encoded.size() * sizeof(wchar_t)));
    RegCloseKey(key);
    return result == ERROR_SUCCESS;
}

bool serviceExists(const wchar_t* name) {
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!manager) return false;
    SC_HANDLE service = OpenServiceW(manager, name, SERVICE_QUERY_STATUS);
    if (service) CloseServiceHandle(service);
    CloseServiceHandle(manager);
    return service != nullptr;
}

fs::path systemDriver(const wchar_t* name) {
    std::wstring root = env(L"SystemRoot");
    if (root.empty()) root = L"C:\\Windows";
    return fs::path(root) / L"System32" / L"drivers" / name;
}

std::wstring serviceBinary(SC_HANDLE service) {
    DWORD needed = 0;
    QueryServiceConfigW(service, nullptr, 0, &needed);
    if (!needed) return {};
    std::vector<BYTE> buffer(needed);
    auto* config = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(buffer.data());
    if (!QueryServiceConfigW(service, config, needed, &needed)) return {};
    std::wstring value = config->lpBinaryPathName ? config->lpBinaryPathName : L"";
    if (!value.empty() && value.front() == L'\"') value = value.substr(1, value.find(L'\"', 1) - 1);
    else if (auto space = value.find(L' '); space != std::wstring::npos) value.resize(space);
    wchar_t expanded[32768]{};
    if (ExpandEnvironmentStringsW(value.c_str(), expanded, 32768)) value = expanded;
    if (value.starts_with(L"\\??\\")) value.erase(0, 4);
    return value;
}

bool stopService(SC_HANDLE service, const std::wstring& name, Logger& log) {
    SERVICE_STATUS status{};
    ControlService(service, SERVICE_CONTROL_STOP, &status);
    auto deadline = GetTickCount64() + kCommandTimeoutMs;
    while (GetTickCount64() < deadline) {
        SERVICE_STATUS_PROCESS process{};
        DWORD bytes = 0;
        if (!QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO, reinterpret_cast<BYTE*>(&process), sizeof(process), &bytes)) break;
        if (process.dwCurrentState == SERVICE_STOPPED) return true;
        Sleep(200);
    }
    log.line(L"WARNING: service did not stop before the timeout: " + name);
    return false;
}

std::vector<std::wstring> legacyServices() {
    std::vector<std::wstring> names;
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ENUMERATE_SERVICE);
    if (!manager) return names;
    DWORD bytes = 0, count = 0, resume = 0;
    EnumServicesStatusExW(manager, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL, nullptr, 0, &bytes, &count, &resume, nullptr);
    std::vector<BYTE> buffer(bytes);
    if (EnumServicesStatusExW(manager, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_STATE_ALL, buffer.data(), bytes, &bytes, &count, &resume, nullptr)) {
        auto* entries = reinterpret_cast<ENUM_SERVICE_STATUS_PROCESSW*>(buffer.data());
        for (DWORD i = 0; i < count; ++i) {
            std::wstring identity = lower(entries[i].lpServiceName ? entries[i].lpServiceName : L"");
            identity += L" ";
            identity += lower(entries[i].lpDisplayName ? entries[i].lpDisplayName : L"");
            if (identity.find(L"namedpipeserver") != std::wstring::npos || identity.find(L"frida") != std::wstring::npos) names.emplace_back(entries[i].lpServiceName);
        }
    }
    CloseServiceHandle(manager);
    return names;
}

void removePath(Logger& log, const fs::path& path, const std::wstring& label) {
    std::error_code error;
    if (fs::is_directory(path, error)) fs::remove_all(path, error); else fs::remove(path, error);
    if (!error) log.line(L"Deleted " + label + L": " + path.wstring());
    else if (error.value() != ERROR_FILE_NOT_FOUND && error.value() != ERROR_PATH_NOT_FOUND) log.line(L"WARNING: could not delete " + label + L": " + path.wstring());
}

void removeNamed(Logger& log, const std::wstring& needle) {
    std::error_code error;
    for (fs::recursive_directory_iterator it(baseDir(), fs::directory_options::skip_permission_denied, error), end; it != end; it.increment(error)) {
        if (lower(it->path().filename().wstring()).find(lower(needle)) != std::wstring::npos) removePath(log, it->path(), needle + L" residual");
    }
}

void stopFrida(Logger& log) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return;
    PROCESSENTRY32W entry{sizeof(entry)};
    if (Process32FirstW(snapshot, &entry)) do {
        if (lower(entry.szExeFile).find(L"frida") == std::wstring::npos) continue;
        HANDLE process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
        if (process) { log.line(L"Stopping Frida process: " + std::wstring(entry.szExeFile)); TerminateProcess(process, 1); CloseHandle(process); }
    } while (Process32NextW(snapshot, &entry));
    CloseHandle(snapshot);
}

void uninstallInterception(Logger& log) {
    struct Target { const wchar_t* service; const wchar_t* key; const wchar_t* file; } targets[] = {{L"keyboard", kKeyboardClass, L"keyboard.sys"}, {L"mouse", kMouseClass, L"mouse.sys"}};
    for (const auto& target : targets) {
        auto filters = readMultiString(target.key, L"UpperFilters");
        bool filter = filters && std::any_of(filters->begin(), filters->end(), [&](const auto& value) { return _wcsicmp(value.c_str(), target.service) == 0; });
        SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
        SC_HANDLE service = manager ? OpenServiceW(manager, target.service, SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE) : nullptr;
        if (service) {
            log.line(L"Stopping Interception driver service: " + std::wstring(target.service));
            stopService(service, target.service, log);
            DeleteService(service);
            CloseServiceHandle(service);
        }
        if (manager) CloseServiceHandle(manager);
        if (filter) {
            std::vector<std::wstring> remaining;
            for (const auto& value : *filters) if (_wcsicmp(value.c_str(), target.service) != 0) remaining.push_back(value);
            if (!setMultiString(target.key, L"UpperFilters", remaining)) log.line(L"WARNING: cannot update UpperFilters.");
        }
        fs::path driver = systemDriver(target.file);
        if (fs::exists(driver)) {
            std::error_code error;
            fs::remove(driver, error);
            if (error) { MoveFileExW(driver.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT | MOVEFILE_WRITE_THROUGH); log.line(L"Scheduled driver deletion after reboot."); }
            else log.line(L"Deleted Interception driver file: " + driver.wstring());
        }
    }
}

void uninstallFix(Logger& log) {
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    SC_HANDLE service = manager ? OpenServiceW(manager, kFixService, SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE) : nullptr;
    if (service) { log.line(L"Stopping service: " + std::wstring(kFixService)); stopService(service, kFixService, log); DeleteService(service); CloseServiceHandle(service); }
    if (manager) CloseServiceHandle(manager);
    fs::path directory(kFixDirectory);
    if (fs::exists(directory)) removePath(log, directory, L"AxonkeyInterceptionFix installation directory");
}

void cleanup(Logger& log) {
    log.line(L"Old driver cleanup started. Base directory: " + baseDir().wstring());
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT | SC_MANAGER_ENUMERATE_SERVICE);
    if (manager) {
        for (const auto& name : legacyServices()) {
            SC_HANDLE service = OpenServiceW(manager, name.c_str(), SERVICE_QUERY_CONFIG | SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE);
            if (!service) continue;
            std::wstring path = serviceBinary(service);
            log.line(L"Stopping legacy service: " + name);
            stopService(service, name, log);
            DeleteService(service);
            CloseServiceHandle(service);
            if (!path.empty() && (lower(path).find(L"namedpipe") != std::wstring::npos || lower(path).find(L"frida") != std::wstring::npos || fs::path(path).wstring().starts_with(baseDir().wstring()))) removePath(log, path, L"legacy service binary");
        }
        CloseServiceHandle(manager);
    }
    stopFrida(log);
    removeNamed(log, L"namedpipeserver");
    removeNamed(log, L"frida");
    uninstallFix(log);
    uninstallInterception(log);
    removePath(log, baseDir() / L"vendor" / L"interception-fix", L"Interception Fix payload");
    removePath(log, baseDir() / L"vendor" / L"interception", L"Interception payload");
}

Components detectComponents() {
    Components components;
    bool keyboard = serviceExists(L"keyboard");
    bool mouse = serviceExists(L"mouse");
    auto keyboardFilters = readMultiString(kKeyboardClass, L"UpperFilters");
    auto mouseFilters = readMultiString(kMouseClass, L"UpperFilters");
    auto contains = [](const auto& values, const wchar_t* name) { return values && std::any_of(values->begin(), values->end(), [&](const auto& value) { return _wcsicmp(value.c_str(), name) == 0; }); };
    components.interception = keyboard || mouse || contains(keyboardFilters, L"keyboard") || contains(mouseFilters, L"mouse") || fs::exists(systemDriver(L"keyboard.sys")) || fs::exists(systemDriver(L"mouse.sys"));
    components.interceptionFix = serviceExists(kFixService) || fs::exists(fs::path(kFixDirectory));
    return components;
}

bool parseOptions(int argc, wchar_t** argv, Options& options) {
    for (int i = 1; i < argc; ++i) {
        std::wstring arg(argv[i]);
        if (arg == L"--confirmed" || arg == L"-y") options.confirmed = true;
        else if (arg == L"--headless") options.headless = true;
        else if (arg == L"--auto-close") options.autoClose = true;
        else if (arg == L"--status") options.status = true;
        else if (arg == L"--log-path" && i + 1 < argc) options.logPath = argv[++i];
        else if (arg == L"--help" || arg == L"-h") { printErr(L"Usage: uninstall-old-driver.exe [--confirmed] [--auto-close] [--headless] [--status] [--log-path PATH]\n"); return false; }
        else { printErr(L"Unknown argument: " + arg + L"\n"); return false; }
    }
    return true;
}

class GuiApp {
public:
    explicit GuiApp(Options options) : options_(std::move(options)) {}
    int run(HINSTANCE instance);
private:
    static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam);
    void start(HWND hwnd);
    void update(HWND hwnd);
    Options options_;
    bool started_ = false;
    std::atomic<bool> finished_{false};
    std::atomic<int> result_{1};
    bool timedOut_ = false;
    ULONGLONG startedAt_ = 0;
    ULONGLONG completedAt_ = 0;
    HWND label_ = nullptr;
    HWND button_ = nullptr;
    std::mutex mutex_;
    std::wstring latest_;
    std::thread worker_;
};

void GuiApp::start(HWND hwnd) {
    if (started_) return;
    started_ = true;
    startedAt_ = GetTickCount64();
    SetWindowTextW(label_, L"正在准备卸载…");
    EnableWindow(button_, FALSE);
    worker_ = std::thread([this, hwnd] {
        Logger log(logPath(options_), [this, hwnd](const auto& message) { std::lock_guard lock(mutex_); latest_ = message; PostMessageW(hwnd, kProgressMessage, 0, 0); });
        if (!log.good()) {
            { std::lock_guard lock(mutex_); latest_ = L"无法创建卸载日志，请检查日志目录权限后重试。"; }
            result_ = 1; finished_ = true; PostMessageW(hwnd, kProgressMessage, 0, 0); return;
        }
        try { cleanup(log); log.line(L"Old driver cleanup completed successfully."); result_ = 0; }
        catch (...) { log.line(L"ERROR: cleanup failed unexpectedly."); result_ = 1; }
        finished_ = true;
        PostMessageW(hwnd, kProgressMessage, 0, 0);
    });
}

void GuiApp::update(HWND hwnd) {
    std::wstring message;
    { std::lock_guard lock(mutex_); message = latest_; }
    if (!message.empty()) SetWindowTextW(label_, message.c_str());
    if (started_ && !finished_ && !timedOut_ && GetTickCount64() - startedAt_ > kCleanupTimeoutMs) {
        timedOut_ = true;
        SetWindowTextW(label_, L"卸载等待时间过长，请查看日志。可强制关闭窗口后重试。");
        SetWindowTextW(button_, L"强制关闭");
        EnableWindow(button_, TRUE);
    }
    if (finished_) {
        if (!completedAt_) completedAt_ = GetTickCount64();
        SetWindowTextW(button_, L"关闭");
        EnableWindow(button_, TRUE);
        if (result_ == 0) SetWindowTextW(label_, L"卸载完成，请重启 Windows 使更改生效。");
        if (result_ == 0 && options_.autoClose && GetTickCount64() - completedAt_ >= 800) {
            DestroyWindow(hwnd);
        }
    }
}

LRESULT CALLBACK GuiApp::windowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* app = reinterpret_cast<GuiApp*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCCREATE) { app = static_cast<GuiApp*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams); SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(app)); }
    if (!app) return DefWindowProcW(hwnd, message, wParam, lParam);
    switch (message) {
    case WM_CREATE:
        app->label_ = CreateWindowW(L"STATIC", L"准备就绪，点击下方按钮开始卸载。", WS_CHILD | WS_VISIBLE | SS_NOPREFIX, 20, 28, 460, 42, hwnd, nullptr, nullptr, nullptr);
        app->button_ = CreateWindowW(L"BUTTON", L"开始卸载", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, 344, 90, 136, 32, hwnd, reinterpret_cast<HMENU>(1), nullptr, nullptr);
        SetTimer(hwnd, kTimer, 100, nullptr);
        if (app->options_.autoStart()) PostMessageW(hwnd, WM_COMMAND, 1, 0);
        return 0;
    case WM_CTLCOLORSTATIC:
        if (reinterpret_cast<HWND>(lParam) == app->label_) {
            SetBkMode(reinterpret_cast<HDC>(wParam), TRANSPARENT);
            return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
        }
        break;
    case WM_COMMAND:
        if (LOWORD(wParam) == 1) {
            if (app->finished_) DestroyWindow(hwnd);
            else if (app->timedOut_) TerminateProcess(GetCurrentProcess(), 124);
            else app->start(hwnd);
            return 0;
        }
        break;
    case kProgressMessage: app->update(hwnd); return 0;
    case WM_TIMER: app->update(hwnd); return 0;
    case WM_CLOSE:
        if (app->timedOut_) TerminateProcess(GetCurrentProcess(), 124);
        if (app->started_ && !app->finished_) return 0;
        DestroyWindow(hwnd); return 0;
    case WM_DESTROY:
        KillTimer(hwnd, kTimer);
        PostQuitMessage(app->result_);
        return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

int GuiApp::run(HINSTANCE instance) {
    const wchar_t className[] = L"AxonkeyUninstallOldDriverWindow";
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = windowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = className;
    RegisterClassW(&windowClass);
    HWND hwnd = CreateWindowExW(WS_EX_APPWINDOW, className, L"Axonkey · 卸载旧组件", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, CW_USEDEFAULT, CW_USEDEFAULT, 520, 175, nullptr, nullptr, instance, this);
    if (!hwnd) return 1;
    ShowWindow(hwnd, SW_SHOWNORMAL);
    UpdateWindow(hwnd);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    if (worker_.joinable()) worker_.join();
    return result_;
}

int runHeadless(const Options& options) {
    const fs::path outputLog = logPath(options);
    std::packaged_task<bool()> task([outputLog] {
        Logger log(outputLog, {});
        if (!log.good()) return false;
        try {
            cleanup(log);
            log.line(L"Old driver cleanup completed successfully.");
            return true;
        } catch (...) {
            log.line(L"ERROR: cleanup failed unexpectedly.");
            return false;
        }
    });
    auto result = task.get_future();
    std::thread worker(std::move(task));
    if (result.wait_for(std::chrono::milliseconds(kCleanupTimeoutMs)) == std::future_status::timeout) {
        worker.detach();
        printErr(L"Cleanup timed out after 180 seconds; inspect the log and retry when ready.\n");
        return 124;
    }
    const bool success = result.get();
    worker.join();
    if (!success) { printErr(L"Cleanup failed; inspect the log for details.\n"); return 1; }
    printOut(L"{\"action\":\"cleanup\",\"success\":true,\"rebootRequired\":false,\"logPath\":" + jsonString(logPath(options)) + L"}\n");
    return 0;
}

} // namespace

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    Options options;
    bool parsed = argv && parseOptions(argc, argv, options);
    if (argv) LocalFree(argv);
    if (!parsed) return 2;

    if (options.status) {
        Components components = detectComponents();
        printOut(L"{\"action\":\"status\",\"components\":{\"interception\":" + std::wstring(components.interception ? L"true" : L"false") + L",\"interceptionFix\":" + std::wstring(components.interceptionFix ? L"true" : L"false") + L"}}\n");
        return 0;
    }
    if (!isAdministrator()) return elevate(options);
    if (options.headless) return runHeadless(options);
    GuiApp app(options);
    return app.run(instance);
}
