#pragma once
#include <windows.h>
#include <string>
#include <vector>
#include "QuarborHidUserProtocol.h"

namespace quarbor { namespace user_filter {
// UI-friendly nonblocking client. Pump from one thread; use Close before
// destruction. The same header/protocol also works in any ordinary Win32 app.
class ReportClient final {
public:
    enum class Result { Waiting, Packet, Error };
    ~ReportClient() { Close(); }
    ReportClient() = default;
    ReportClient(const ReportClient&) = delete;
    ReportClient& operator=(const ReportClient&) = delete;
    static std::vector<std::wstring> Enumerate();
    DWORD Connect(const std::wstring& path);
    void Close();
    Result Pump(hid_user::Packet& packet);
    DWORD Error() const { return error_; }
    bool Connected() const { return pipe_ != INVALID_HANDLE_VALUE; }
private:
    Result Fail(DWORD error);
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    OVERLAPPED operation_{};
    hid_user::Packet packet_{};
    DWORD offset_ = 0, target_ = sizeof(hid_user::Header), error_ = 0;
    bool pending_ = false, expectHello_ = true;
};
} }
