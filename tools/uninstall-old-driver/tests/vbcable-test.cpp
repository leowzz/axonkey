#include <windows.h>
#include "../src/vbcable.h"

#include <filesystem>
#include <algorithm>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace fs = std::filesystem;

void writeInf(const fs::path& directory, const wchar_t* name, const char* strings) {
    std::ofstream file(directory / name);
    file << "[Version]\nSignature=\"$Windows NT$\"\nClass=MEDIA\n"
            "ClassGUID={4d36e96c-e325-11ce-bfc1-08002be10318}\nProvider=VB-Audio\n"
            "[Strings]\n" << strings;
}

int main() {
    const auto directory = fs::temp_directory_path() / (L"axonkey-vbcable-inf-test-" + std::to_wstring(GetCurrentProcessId()));
    fs::create_directory(directory);
    int code = 0;
    try {
        writeInf(directory, L"oem1.inf", "HardwareId=VBAudioVACWDM\nServiceName=VBAudioVACMME\n");
        writeInf(directory, L"OEM22.INF", "HardwareId = \"vbaudiovacwdm\" ; comment\nServiceName = \"vbaudiovacmme\"\n");
        writeInf(directory, L"oem3.inf", "HardwareId=VBAudioVACWDM_A\nServiceName=VBAudioVACMME\n");
        writeInf(directory, L"oem4.inf", "HardwareId=VBAudioVACWDM\nServiceName=OtherDriver\n");
        writeInf(directory, L"oem5.inf", "; HardwareId=VBAudioVACWDM\nServiceName=VBAudioVACMME\n");
        writeInf(directory, L"oem6.inf", "HardwareId=QuarborVirtualMicrophoneDriver\nServiceName=QuarborVirtualMicrophoneDriver\n");
        writeInf(directory, L"oem7.inf", "HardwareId=VBAudioVACWDM_B\nServiceName=VBAudioVACMME_B\n");
        writeInf(directory, L"oem8.inf", "HardwareId=VBAudioVoicemeeterVAIO\nServiceName=VBAudioVoicemeeter\n");
        writeInf(directory, L"vbMmeCable.inf", "HardwareId=VBAudioVACWDM\nServiceName=VBAudioVACMME\n");
        writeInf(directory, L"oem.inf", "HardwareId=VBAudioVACWDM\nServiceName=VBAudioVACMME\n");
        writeInf(directory, L"oem1x.inf", "HardwareId=VBAudioVACWDM\nServiceName=VBAudioVACMME\n");
        fs::create_directory(directory / L"oem99.inf");
        const auto packages = vbcable::findPackages(directory);
        if (packages.size() != 2) throw std::runtime_error("Expected exactly two standard VB-CABLE packages");
        for (const auto& package : packages) {
            const auto name = package.filename().wstring();
            if (name != L"oem1.inf" && name != L"OEM22.INF") throw std::runtime_error("Matched a different product or non-OEM INF");
        }
        fs::remove(directory / L"oem1.inf");
        fs::remove(directory / L"OEM22.INF");
        if (!vbcable::findPackages(directory).empty()) throw std::runtime_error("Unexpected remaining matches");
        std::cout << "VB-CABLE native INF selection tests passed (12 fixtures).\n";

        const auto application = directory / L"application";
        const auto legacy = application / L"vendor" / L"vbcable";
        const auto quarbor = application / L"vendor" / L"QuarborVirtualMicrophoneDriverInstaller";
        fs::create_directories(legacy / L"nested");
        fs::create_directories(quarbor);
        std::ofstream(legacy / L"nested" / L"old-driver.zip") << "old package";
        std::ofstream(quarbor / L"installer.exe") << "keep";
        const auto plan = vbcable::inspect(application);
        if (std::find(plan.files.begin(), plan.files.end(), legacy / L"nested" / L"old-driver.zip") == plan.files.end() ||
            std::find(plan.directories.begin(), plan.directories.end(), legacy) == plan.directories.end()) {
            throw std::runtime_error("Local vendor/vbcable directory is missing from the cleanup plan");
        }
        if (std::find(plan.files.begin(), plan.files.end(), quarbor / L"installer.exe") != plan.files.end() ||
            std::find(plan.directories.begin(), plan.directories.end(), application / L"vendor") != plan.directories.end()) {
            throw std::runtime_error("Cleanup plan includes unrelated vendor files");
        }
        if (!fs::exists(legacy / L"nested" / L"old-driver.zip")) throw std::runtime_error("Inspection modified local vendor files");
        fs::remove_all(legacy);
        const auto absent = vbcable::inspect(application);
        if (std::find(absent.directories.begin(), absent.directories.end(), legacy) != absent.directories.end()) {
            throw std::runtime_error("Missing local vendor directory should be skipped");
        }
        std::cout << "Local vendor/vbcable cleanup plan tests passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        code = 1;
    }
    // This path is created above under the system temporary directory and never contains system drivers.
    fs::remove_all(directory);
    return code;
}
