#pragma once
#include "QuarborHidUserProtocol.h"
#include <string>
#include <vector>
#include <windows.h>

namespace quarbor
{
namespace user_filter
{
class ReportClient final
{
  public:
    enum class Result
    {
        Waiting,
        Packet,
        Error
    };
    ~ReportClient()
    {
        Close();
    }
    ReportClient() = default;
    ReportClient(const ReportClient &) = delete;
    ReportClient &operator=(const ReportClient &) = delete;
    static std::vector<std::wstring> Enumerate();
    DWORD Connect(const std::wstring &path);
    DWORD Handshake();
    DWORD Cancel();
    void Close();
    Result Pump(hid_user::Packet &packet);
    DWORD SubmitReply(const hid_user::Packet &request, const void *replacement, size_t length);
    DWORD SubmitReply(const hid_user::Header &request, const void *replacement, size_t length);
    bool IsHandshaken() const
    {
        return handshaken_;
    }
    DWORD Error() const
    {
        return error_;
    }
    bool Connected() const
    {
        return pipe_ != INVALID_HANDLE_VALUE;
    }

  private:
    Result Fail(DWORD error);
    DWORD SendFrame(const hid_user::Packet &packet);
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    OVERLAPPED readOperation_{};
    OVERLAPPED writeOperation_{};
    HANDLE writeEvent_ = nullptr;
    hid_user::Packet packet_{};
    DWORD offset_ = 0, target_ = sizeof(hid_user::Header), error_ = 0;
    bool pendingRead_ = false, handshaken_ = false, expectHello_ = true;
    uint64_t sessionId_ = 0;
};
} // namespace user_filter
} // namespace quarbor
