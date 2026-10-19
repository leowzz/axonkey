#include "ReportClient.h"
#include "QuarborHidUserCodec.h"
#include "QuarborHidUserMemory.h"
#ifndef STATUS_WAIT_0
#include <winternl.h>
#include <ntstatus.h>
#endif
#include <algorithm>

namespace quarbor { namespace user_filter {
using hid_user::Wiped;

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
DWORD ReportClient::Connect(const std::wstring& path, bool writable) {
    Close();
    operation_ = {};
    operation_.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!operation_.hEvent) return error_ = GetLastError();
    pipe_ = CreateFileW(path.c_str(), GENERIC_READ | (writable ? FILE_WRITE_DATA : 0), 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (pipe_ == INVALID_HANDLE_VALUE) {
        error_ = GetLastError();
        Close();
        return error_;
    }
    writable_ = writable;
    return error_ = ERROR_SUCCESS;
}
void ReportClient::Close() {
    writable_ = false;
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
    lastRequestId_ = 0;
    expectHello_ = true;
    ResetFrame();
}
void ReportClient::ResetFrame() {
    SecureZeroMemory(frame_, sizeof(frame_));
    offset_ = 0;
    target_ = hid_user::FramePrefixBytes;
    receiveDeadline_ = 0;
}
DWORD ReportClient::SendReport(const void* bytes, size_t length, uint64_t requestId) {
    if (!bytes || !length || length > hid_user::MaxPayload) return ERROR_INVALID_PARAMETER;
    Wiped<hid_user::Packet> storage;
    auto& command = storage.value;
    command.header.type = hid_user::InjectReport;
    command.header.requestId = requestId;
    command.header.payloadBytes = static_cast<uint32_t>(length);
    CopyMemory(command.payload, bytes, length);
    return SendCommand(command);
}
DWORD ReportClient::SendKey(uint16_t usagePage, uint16_t usage, uint8_t action, uint64_t requestId,
    uint16_t reportId) {
    Wiped<hid_user::Packet> storage;
    auto& command = storage.value;
    command.header.type = hid_user::InjectKey;
    command.header.requestId = requestId;
    command.key = {usagePage, usage, action, reportId};
    return SendCommand(command);
}
DWORD ReportClient::ResetInput(uint64_t requestId) {
    Wiped<hid_user::Packet> storage;
    auto& command = storage.value;
    command.header.type = hid_user::ResetInput;
    command.header.requestId = requestId;
    return SendCommand(command);
}
DWORD ReportClient::QueryInputDiagnostics(uint64_t requestId) {
    Wiped<hid_user::Packet> storage;
    auto& command = storage.value;
    command.header.type = hid_user::QueryInputDiagnostics;
    command.header.requestId = requestId;
    return SendCommand(command);
}
DWORD ReportClient::SendCommand(const hid_user::Packet& command) {
    if (!Connected()) return ERROR_INVALID_HANDLE;
    if (!writable_) return ERROR_ACCESS_DENIED;
    if (command.header.requestId <= lastRequestId_) return ERROR_INVALID_PARAMETER;
    Wiped<uint8_t[hid_user::MaxFrameBytes]> storage;
    auto& frame = storage.value;
    size_t length = 0;
    if (!hid_user::EncodeClientFrame(command, frame, sizeof(frame), length)) return ERROR_INVALID_PARAMETER;
    OVERLAPPED operation{};
    operation.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!operation.hEvent) return GetLastError();
    const DWORD total = static_cast<DWORD>(length);
    DWORD transferred = 0, error = ERROR_SUCCESS;
    if (!WriteFile(pipe_, frame, total, nullptr, &operation)) {
        error = GetLastError();
        if (error == ERROR_IO_PENDING) {
            if (WaitForSingleObject(operation.hEvent, hid_user::FrameTimeoutMs) == WAIT_OBJECT_0) error = ERROR_SUCCESS;
            else {
                CancelIoEx(pipe_, &operation);
                GetOverlappedResult(pipe_, &operation, &transferred, TRUE);
                error = ERROR_TIMEOUT;
            }
        }
    }
    if (!error && !GetOverlappedResult(pipe_, &operation, &transferred, FALSE)) error = GetLastError();
    if (!error && transferred != total) error = ERROR_WRITE_FAULT;
    CloseHandle(operation.hEvent);
    if (error) { error_ = error; Close(); } // 不能在可能已写出半帧的连接上继续。
    else lastRequestId_ = command.header.requestId;
    return error;
}
ReportClient::Result ReportClient::Fail(DWORD error) {
    error_ = error;
    Close();
    return Result::Error;
}
ReportClient::Result ReportClient::Pump(hid_user::Packet& packet) {
    if (!Connected()) return Fail(ERROR_INVALID_HANDLE);
    if (receiveDeadline_ && GetTickCount64() >= receiveDeadline_) return Fail(ERROR_TIMEOUT);
    // 按长度前缀累积一帧；字节管道可能在任意位置拆分一次写入。
    for (int step = 0; step < 8; ++step) {
        DWORD bytes = 0;
        if (!pending_) {
            ResetEvent(operation_.hEvent);
            const BOOL result = ReadFile(pipe_, frame_ + offset_,
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
        if (!receiveDeadline_) receiveDeadline_ = GetTickCount64() + hid_user::FrameTimeoutMs;
        if (GetTickCount64() >= receiveDeadline_) return Fail(ERROR_TIMEOUT);
        offset_ += bytes;
        if (offset_ != target_) continue;
        if (target_ == hid_user::FramePrefixBytes) {
            const auto length = hid_user::ReadFrameLength(frame_);
            if (!length || length > hid_user::MaxMessageBytes) return Fail(ERROR_BAD_FORMAT);
            target_ += length;
            continue;
        }
        Wiped<hid_user::Packet> storage;
        auto& decoded = storage.value;
        if (!hid_user::DecodeServerMessage(frame_ + hid_user::FramePrefixBytes,
                target_ - hid_user::FramePrefixBytes, decoded) ||
            (expectHello_ ? decoded.header.type != hid_user::Hello : decoded.header.type == hid_user::Hello))
            return Fail(ERROR_BAD_FORMAT);
        expectHello_ = false;
        packet = decoded;
        ResetFrame();
        return Result::Packet;
    }
    return Result::Waiting;
}
} }
