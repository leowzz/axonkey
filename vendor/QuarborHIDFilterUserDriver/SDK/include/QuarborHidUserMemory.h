#pragma once
#include <windows.h>
#include <type_traits>

namespace quarbor { namespace hid_user {
// 仅用于普通数据和定长数组；离开作用域时擦除，覆盖正常和提前返回路径。
template<class T> struct Wiped final {
    static_assert(std::is_trivially_copyable<T>::value, "Wiped requires plain data");
    T value{};
    Wiped() = default;
    ~Wiped() { SecureZeroMemory(&value, sizeof(value)); }
    Wiped(const Wiped&) = delete;
    Wiped& operator=(const Wiped&) = delete;
};
} }
