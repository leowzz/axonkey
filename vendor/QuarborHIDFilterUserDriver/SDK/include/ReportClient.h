#pragma once
#include <windows.h>
#include <string>
#include <vector>
#include "QuarborHidUserProtocol.h"

namespace quarbor { namespace user_filter {
// 普通 Win32 客户端：同一线程调用，Pump 不等待输入，析构自动取消并回收 I/O。
class ReportClient final {
public:
    enum class Result { Waiting, Packet, Error };
    ~ReportClient() { Close(); }
    ReportClient() = default;
    ReportClient(const ReportClient&) = delete;
    ReportClient& operator=(const ReportClient&) = delete;
    static std::vector<std::wstring> Enumerate();
    DWORD Connect(const std::wstring& path, bool writable = false);
    // 返回值仅表示整帧写入成功。Pump 接收 InjectResult，以 requestId 关联入队结果。
    DWORD SendReport(const void* bytes, size_t length, uint64_t requestId);
    DWORD SendKey(uint16_t usagePage, uint16_t usage, uint8_t action, uint64_t requestId,
        uint16_t reportId = hid_user::AnyReportId);
    DWORD ResetInput(uint64_t requestId);
    DWORD QueryInputDiagnostics(uint64_t requestId);
    void Close();
    Result Pump(hid_user::Packet& packet);
    DWORD Error() const { return error_; }
    bool Connected() const { return pipe_ != INVALID_HANDLE_VALUE; }
private:
    void ResetFrame(); // 一帧交付后复位接收状态，同时清理报告字节。
    Result Fail(DWORD error);
    DWORD SendCommand(const hid_user::Packet& command);
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    OVERLAPPED operation_{};
    uint8_t frame_[hid_user::MaxFrameBytes]{};
    DWORD offset_ = 0, target_ = hid_user::FramePrefixBytes, error_ = 0;
    uint64_t lastRequestId_ = 0;
    ULONGLONG receiveDeadline_ = 0;
    bool pending_ = false, expectHello_ = true;
    bool writable_ = false;
};
} }
