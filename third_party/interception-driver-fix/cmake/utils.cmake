function(hy_genex_debug _expr)
    set_property(GLOBAL APPEND PROPERTY _my_genex_debug_list "${_expr}")
endfunction()


function(hy_finalize_genex_debug)
    get_property(_my_list GLOBAL PROPERTY _my_genex_debug_list)

    list(JOIN _my_list "\n" _file_content)

    file(GENERATE
         OUTPUT "${CMAKE_BINARY_DIR}/__genex-debug.txt"
         CONTENT "${_file_content}\n"
    )
endfunction()
cmake_language(DEFER CALL hy_finalize_genex_debug)


function(hy_print_all_variables)
    get_cmake_property(_variables VARIABLES)
    foreach(_item ${_variables})
        message("[VARIABLE] ${_item} = ${${_item}}")
    endforeach()
endfunction()


function(hy_get_os_tag retval)
    set(_os_map [=[{
        "Windows": "win",
        "Linux":   "linux"
    }]=])
    string(JSON ${retval} GET ${_os_map} ${CMAKE_SYSTEM_NAME})

    return(PROPAGATE ${retval})
endfunction()


function(hy_get_arch_tag retval)
    if(CMAKE_SIZEOF_VOID_P EQUAL 8)
        set(${retval} "x64")
    else()
        set(${retval} "x86")
    endif()

    return(PROPAGATE ${retval})
endfunction()


function(hy_get_config_tag retval)
    set(${retval} "$<$<CONFIG:Debug>:debug>$<$<CONFIG:release>:release>$<$<CONFIG:RelWithDebInfo>:reldebug>")

    return(PROPAGATE ${retval})
endfunction()


function(hy_get_dist_name retval)
    hy_get_os_tag(_os_tag)
    hy_get_arch_tag(_arch_tag)
    hy_get_config_tag(_config_tag)

    set(${retval} "${PROJECT_NAME}-v${PROJECT_VERSION}-${_os_tag}-${_arch_tag}-${_config_tag}")

    return(PROPAGATE ${retval})
endfunction()


# include(CheckCSourceCompiles)


# check_c_source_compiles("
# #if defined(__x86_64__) || defined(_M_X64)
# int main(void) { return 0; }
# #else
# #error
# #endif
# " _is_x64)


# check_c_source_compiles("
# #if defined(__aarch64__)
# int main(void) { return 0; }
# #else
# #error
# #endif
# " _is_aarch64)


# CMAKE_GENERATOR_PLATFORM
# CMAKE_VS_PLATFORM_NAME
# CMAKE_VS_PLATFORM_NAME_DEFAULT
