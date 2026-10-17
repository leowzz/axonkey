#include "ReportClient.h"
#include <algorithm>

namespace quarbor { namespace user_filter {
std::vector<std::wstring> ReportClient::Enumerate() {
    std::vector<std::wstring> paths;
    WIN32_FIND_DATAW data{};
    const HANDLE search = FindFirstFileW(L"\\\\.\\pipe\\*", &data);
    if (search == INVALID_HANDLE_VALUE) return paths;
    do {
        if (wcsncmp(data.cFileName, hid_user::PipePrefix, wcslen(hid_user::PipePrefix)) == 0)
            paths.emplace_back(std::wstring(L"\\\\.\\pipe\\") + data.cFileName);
    } while (FindNextFileW(search, &data));
    FindClose(search);
    std::sort(paths.begin(), paths.end());
    return paths;
}
DWORD ReportClient::Connect(const std::wstring& path) {
    Close();
    operation_ = {};
    operation_.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!operation_.hEvent) return error_ = GetLastError();
    pipe_ = CreateFileW(path.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (pipe_ == INVALID_HANDLE_VALUE) {
        error_ = GetLastError();
        Close();
        return error_;
    }
    offset_ = 0;
    target_ = sizeof(hid_user::Header);
    expectHello_ = true;
    return error_ = ERROR_SUCCESS;
}
void ReportClient::Close() {
    if (pipe_ != INVALID_HANDLE_VALUE) {
        if (pending_) {
            CancelIoEx(pipe_, &operation_);
            DWORD bytes;
            GetOverlappedResult(pipe_, &operation_, &bytes, TRUE);
        }
        CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }
    if (operation_.hEvent) { CloseHandle(operation_.hEvent); operation_.hEvent = nullptr; }
    pending_ = false;
}
ReportClient::Result ReportClient::Fail(DWORD error) {
    error_ = error;
    Close();
    return Result::Error;
}
ReportClient::Result ReportClient::Pump(hid_user::Packet& packet) {
    if (!Connected()) return Fail(ERROR_INVALID_HANDLE);
    // Read exactly one header/payload; byte pipes may split any write.
    for (int step = 0; step < 8; ++step) {
        DWORD bytes = 0;
        if (!pending_) {
            ResetEvent(operation_.hEvent);
            const BOOL result = ReadFile(pipe_, reinterpret_cast<BYTE*>(&packet_) + offset_,
                target_ - offset_, nullptr, &operation_);
            if (!result && GetLastError() != ERROR_IO_PENDING) return Fail(GetLastError());
            pending_ = true;
        }
        if (!GetOverlappedResult(pipe_, &operation_, &bytes, FALSE)) {
            const DWORD error = GetLastError();
            if (error == ERROR_IO_INCOMPLETE) return Result::Waiting;
            pending_ = false;
            return Fail(error);
        }
        pending_ = false;
        if (!bytes || bytes > target_ - offset_) return Fail(ERROR_INVALID_DATA);
        offset_ += bytes;
        if (offset_ != target_) continue;
        if (target_ == sizeof(hid_user::Header)) {
            if (!hid_user::ValidHeader(packet_.header) ||
                (expectHello_ ? packet_.header.type != hid_user::Hello : packet_.header.type == hid_user::Hello))
                return Fail(ERROR_BAD_FORMAT);
            target_ += packet_.header.payloadBytes;
            if (offset_ != target_) continue;
        }
        if (packet_.header.type == hid_user::Hello) {
            const auto size = packet_.header.payloadBytes;
            if (packet_.payload[size - 1] || packet_.payload[size - 2]) return Fail(ERROR_BAD_FORMAT);
            expectHello_ = false;
        }
        packet = packet_;
        offset_ = 0;
        target_ = sizeof(hid_user::Header);
        return Result::Packet;
    }
    return Result::Waiting;
}
} }
