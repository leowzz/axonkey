#pragma once

#include <filesystem>
#include <functional>
#include <string>
#include <vector>

namespace vbcable {

struct Plan {
    std::vector<std::wstring> devices;
    std::vector<std::filesystem::path> packages;
    std::vector<std::filesystem::path> files;
    std::vector<std::filesystem::path> directories;
};

struct Result {
    bool rebootRequired = false;
    unsigned devicesRemoved = 0;
    unsigned packagesRemoved = 0;
    std::vector<std::wstring> errors;
};

std::vector<std::wstring> findDevices();
std::vector<std::filesystem::path> findPackages(const std::filesystem::path& directory);
Plan inspect(const std::filesystem::path& applicationDirectory);
Result uninstall(const Plan& plan, const std::function<void(const std::wstring&)>& log);

} // namespace vbcable
