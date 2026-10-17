#include "ReportClient.h"
#include <algorithm>
#include <strsafe.h>
#ifndef STATUS_WAIT_0
#define STATUS_WAIT_0 ((DWORD)0x00000000L)
#endif

namespace quarbor
{
namespace user_filter
{
std::vector<std::wstring> ReportClient::Enumerate()
{
    std::vector<std::wstring> paths;
    WIN32_FIND_DATAW data{};
    const HANDLE search = FindFirstFileW(L"\\\\.\\pipe\\*", &data);
    if (search == INVALID_HANDLE_VALUE)
        return paths;
    do
    {
        if (wcsncmp(data.cFileName, hid_user::PipePrefix, wcslen(hid_user::PipePrefix)) == 0)
            paths.emplace_back(std::wstring(L"\\\\.\\pipe\\") + data.cFileName);
    } while (FindNextFileW(search, &data));
    FindClose(search);
    std::sort(paths.begin(), paths.end());
    return paths;
}
DWORD ReportClient::Connect(const std::wstring &path)
{
    Close();
    readOperation_ = {};
    writeOperation_ = {};
    readOperation_.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    writeEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!readOperation_.hEvent || !writeEvent_)
    {
        error_ = GetLastError();
        Close();
        return error_;
    }
    pipe_ = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (pipe_ == INVALID_HANDLE_VALUE)
    {
        error_ = GetLastError();
        Close();
        return error_;
    }
    offset_ = 0;
    target_ = sizeof(hid_user::Header);
    pendingRead_ = false;
    handshaken_ = false;
    expectHello_ = true;
    sessionId_ = 0;
    error_ = ERROR_SUCCESS;
    return error_;
}
void ReportClient::Close()
{
    if (pipe_ != INVALID_HANDLE_VALUE)
    {
        Cancel();
        CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }
    if (readOperation_.hEvent)
    {
        CloseHandle(readOperation_.hEvent);
        readOperation_.hEvent = nullptr;
    }
    if (writeEvent_)
    {
        CloseHandle(writeEvent_);
        writeEvent_ = nullptr;
    }
    pendingRead_ = false;
    handshaken_ = false;
    expectHello_ = true;
    sessionId_ = 0;
}
DWORD ReportClient::Cancel()
{
    if (pipe_ == INVALID_HANDLE_VALUE)
        return ERROR_INVALID_HANDLE;
    if (pendingRead_)
    {
        CancelIoEx(pipe_, &readOperation_);
        DWORD bytes = 0;
        GetOverlappedResult(pipe_, &readOperation_, &bytes, TRUE);
        pendingRead_ = false;
    }
    CancelIoEx(pipe_, &writeOperation_);
    return ERROR_SUCCESS;
}
ReportClient::Result ReportClient::Fail(DWORD error)
{
    error_ = error;
    Close();
    return Result::Error;
}
DWORD ReportClient::SendFrame(const hid_user::Packet &packet)
{
    if (!Connected() || !hid_user::ValidHeader(packet.header))
        return ERROR_INVALID_DATA;
    const DWORD total = sizeof(hid_user::Header) + packet.header.payloadBytes;
    DWORD offset = 0;
    while (offset < total)
    {
        ResetEvent(writeEvent_);
        writeOperation_ = {};
        writeOperation_.hEvent = writeEvent_;
        DWORD bytes = 0;
        const BOOL ok = WriteFile(pipe_, reinterpret_cast<const BYTE *>(&packet) + offset, total - offset, &bytes,
                                  &writeOperation_);
        if (!ok && GetLastError() != ERROR_IO_PENDING)
            return GetLastError();
        if (!ok &&
            WaitForSingleObject(writeEvent_, packet.header.timeoutMs ? packet.header.timeoutMs : 2000) != WAIT_OBJECT_0)
        {
            CancelIoEx(pipe_, &writeOperation_);
            return ERROR_TIMEOUT;
        }
        if (!GetOverlappedResult(pipe_, &writeOperation_, &bytes, TRUE) || !bytes)
            return GetLastError();
        offset += bytes;
    }
    return ERROR_SUCCESS;
}
DWORD ReportClient::Handshake()
{
    if (!Connected())
        return ERROR_INVALID_HANDLE;
    if (handshaken_)
        return ERROR_SUCCESS;
    hid_user::Packet packet{};
    packet.header = {hid_user::Magic,
                     hid_user::Version,
                     hid_user::ClientHello,
                     sizeof(hid_user::Header),
                     sizeof(hid_user::ClientHelloPayload),
                     sessionId_,
                     0,
                     0,
                     0,
                     0,
                     0,
                     0,
                     0,
                     0};
    auto *hello = reinterpret_cast<hid_user::ClientHelloPayload *>(packet.payload);
    hello->protocolVersion = hid_user::Version;
    hello->headerBytes = sizeof(hid_user::Header);
    hello->capabilities = 1;
    hello->maxReportBytes = hid_user::MaxReport;
    const DWORD e = SendFrame(packet);
    if (!e)
        handshaken_ = true;
    else
        error_ = e;
    return e;
}
DWORD ReportClient::SubmitReply(const hid_user::Packet &request, const void *replacement, size_t length)
{
    if (!replacement || !length || length != request.header.payloadBytes ||
        request.payload[0] != static_cast<const BYTE *>(replacement)[0])
        return ERROR_INVALID_DATA;
    return SubmitReply(request.header, replacement, length);
}
DWORD ReportClient::SubmitReply(const hid_user::Header &request, const void *replacement, size_t length)
{
    if (!Connected() || !handshaken_)
        return ERROR_INVALID_STATE;
    if (!replacement || !length || length > hid_user::MaxReport || length != request.payloadBytes ||
        request.sessionId != sessionId_)
        return ERROR_INVALID_DATA;
    hid_user::Packet packet{};
    packet.header = {hid_user::Magic,
                     hid_user::Version,
                     hid_user::ReportReply,
                     sizeof(hid_user::Header),
                     static_cast<uint32_t>(length),
                     request.sessionId,
                     request.sequence,
                     0,
                     request.timeoutMs,
                     request.deadlineMs,
                     0,
                     0,
                     0,
                     0};
    CopyMemory(packet.payload, replacement, length);
    return SendFrame(packet);
}
ReportClient::Result ReportClient::Pump(hid_user::Packet &packet)
{
    if (!Connected())
        return Fail(ERROR_INVALID_HANDLE);
    for (int step = 0; step < 8; ++step)
    {
        DWORD bytes = 0;
        if (!pendingRead_)
        {
            HANDLE event = readOperation_.hEvent;
            ResetEvent(event);
            readOperation_ = {};
            readOperation_.hEvent = event;
            const BOOL ok = ReadFile(pipe_, reinterpret_cast<BYTE *>(&packet_) + offset_, target_ - offset_, nullptr,
                                     &readOperation_);
            if (!ok && GetLastError() != ERROR_IO_PENDING)
                return Fail(GetLastError());
            pendingRead_ = true;
        }
        if (!GetOverlappedResult(pipe_, &readOperation_, &bytes, FALSE))
        {
            if (GetLastError() == ERROR_IO_INCOMPLETE)
                return Result::Waiting;
            pendingRead_ = false;
            return Fail(GetLastError());
        }
        pendingRead_ = false;
        if (!bytes || bytes > target_ - offset_)
            return Fail(ERROR_INVALID_DATA);
        offset_ += bytes;
        if (offset_ != target_)
            continue;
        if (target_ == sizeof(hid_user::Header))
        {
            if (!hid_user::ValidHeader(packet_.header) || packet_.header.type == hid_user::ClientHello ||
                packet_.header.type == hid_user::ReportReply ||
                (expectHello_ ? packet_.header.type != hid_user::Hello : packet_.header.type == hid_user::Hello))
                return Fail(ERROR_BAD_FORMAT);
            if (!expectHello_ && !handshaken_)
                return Fail(ERROR_INVALID_STATE);
            target_ += packet_.header.payloadBytes;
            if (target_ > sizeof(packet_))
                return Fail(ERROR_BAD_FORMAT);
            if (offset_ != target_)
                continue;
        }
        if (packet_.header.type == hid_user::Hello)
        {
            const auto n = packet_.header.payloadBytes;
            if (n < sizeof(wchar_t) || packet_.payload[n - 1] || packet_.payload[n - 2])
                return Fail(ERROR_BAD_FORMAT);
            sessionId_ = packet_.header.sessionId;
            expectHello_ = false;
        }
        packet = packet_;
        offset_ = 0;
        target_ = sizeof(hid_user::Header);
        return Result::Packet;
    }
    return Result::Waiting;
}
} // namespace user_filter
} // namespace quarbor
