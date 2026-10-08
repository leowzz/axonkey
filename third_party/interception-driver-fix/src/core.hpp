// Copyright (c) 2025 Hygor Ostrowskij de Morais <hygor.o.morais@gmail.com>

#pragma once

#include <hy_windows.h>
#include <ntstatus.h>
#include <phnt.h>
#include <tlhelp32.h>
#include <sddl.h>
#include <spdlog/spdlog.h>
#include "cli.hpp"


namespace hy {


inline void create_symlink(std::string link, std::string target) {
    NTSTATUS ret;

    auto link_name_buffer   = widen(link);
    auto target_name_buffer = widen(target);
    UNICODE_STRING link_name;
    UNICODE_STRING target_name;
    RtlInitUnicodeString(&link_name,   link_name_buffer.data());
    RtlInitUnicodeString(&target_name, target_name_buffer.data());

    OBJECT_ATTRIBUTES link_obj_attrs;

    InitializeObjectAttributes(
        &link_obj_attrs,
        &link_name,
        OBJ_PERMANENT,
        nullptr,
        nullptr
    );

    HANDLE link_handle = nullptr;
    ret = NtCreateSymbolicLinkObject(
        &link_handle,
        SYMBOLIC_LINK_ALL_ACCESS,
        &link_obj_attrs,
        &target_name
    );

    // Expected errors for NtCreateSymbolicLinkObject
    // STATUS_OBJECT_NAME_COLLISION  // A symlink object with the same link name already exists.
    // STATUS_OBJECT_TYPE_MISMATCH   // A non-symlink object with the same link name already exists.

    if (ret != STATUS_SUCCESS
        && ret != STATUS_OBJECT_NAME_COLLISION
        && ret != STATUS_OBJECT_TYPE_MISMATCH
    ) {
        throw std::runtime_error(fmt::format("NtCreateSymbolicLinkObject error (0x{:x}).", static_cast<ULONG>(ret)));
    }

    if (ret == STATUS_SUCCESS) NtClose(link_handle);
}


inline void remove_symlink(std::string link) {
    NTSTATUS ret;

    auto link_name_buffer = widen(link);
    UNICODE_STRING link_name;
    RtlInitUnicodeString(&link_name, link_name_buffer.data());

    OBJECT_ATTRIBUTES link_obj_attrs;

    InitializeObjectAttributes(
        &link_obj_attrs,
        &link_name,
        0,
        nullptr,
        nullptr
    );

    HANDLE link_handle = nullptr;
    ret = NtOpenSymbolicLinkObject(
        &link_handle,
        DELETE,
        &link_obj_attrs
    );
    if (ret == STATUS_OBJECT_NAME_NOT_FOUND) {
        return;  // No symlink to delete (and no handle to close, I think.)
    }
    if (ret < 0) {
        throw std::runtime_error(fmt::format("NtOpenSymbolicLinkObject error (0x{:x}).", static_cast<ULONG>(ret)));
    }

    ret = NtMakeTemporaryObject(link_handle);
    if (ret < 0) {
        throw std::runtime_error(fmt::format("NtMakeTemporaryObject error (0x{:x}).", static_cast<ULONG>(ret)));
    }

    NtClose(link_handle);
}


inline int real_main(AppMainConfig cfg) {
    if (cfg.lockdown) {
        throw std::runtime_error("Axonkey requires lockdown=no; device ACL changes are disabled.");
    }

    for (int i = 10; i < cfg.n_keyboard_symlinks; i += 10) {
        for (int j = 0; j < 10; j++) {
            auto link   = fmt::format("\\Device\\KeyboardClass{}", i+j);
            auto target = fmt::format("\\Device\\KeyboardClass{}", j);

            spdlog::debug("Symlinking {} to {}", link, target);

            create_symlink(link, target);
        }
    }

    for (int i = 10; i < cfg.n_pointer_symlinks; i += 10) {
        for (int j = 0; j < 10; j++) {
            auto link   = fmt::format("\\Device\\PointerClass{}", i+j);
            auto target = fmt::format("\\Device\\PointerClass{}", j);

            spdlog::debug("Symlinking {} to {}", link, target);

            create_symlink(link, target);
        }
    }

    spdlog::info("Success");

    return 0;
}


}  // namespace
