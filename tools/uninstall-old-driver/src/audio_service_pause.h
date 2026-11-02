#pragma once

#include <windows.h>
#include <functional>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

template <typename Services>
class AudioServicePause {
public:
    AudioServicePause(Services& services, std::function<void(const std::system_error&)> onError)
        : services_(services), onError_(std::move(onError)) {}
    AudioServicePause(const AudioServicePause&) = delete;
    AudioServicePause& operator=(const AudioServicePause&) = delete;

    ~AudioServicePause() {
        for (auto item = stopped_.rbegin(); item != stopped_.rend(); ++item) {
            try { services_.restore(item->first, item->second); }
            catch (const std::system_error& error) { onError_(error); }
        }
    }

    void stop(const std::wstring& name) {
        const auto original = services_.state(name);
        if (original == SERVICE_STOPPED) return;
        for (const auto& dependent : services_.dependents(name)) stop(dependent);
        // A stop request can succeed before waiting for SERVICE_STOPPED fails.
        stopped_.emplace_back(name, original);
        services_.stop(name);
    }

private:
    Services& services_;
    std::function<void(const std::system_error&)> onError_;
    std::vector<std::pair<std::wstring, DWORD>> stopped_;
};
