cmake_minimum_required(VERSION 4.2)
project(interception-driver-fix
    LANGUAGES CXX
    VERSION "0.5.2"
)


include(CTest)
include(cmake/utils.cmake)


find_package(fmt CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)
find_package(CLI11 CONFIG REQUIRED)
find_package(Boost REQUIRED COMPONENTS algorithm)

add_executable(${PROJECT_NAME})
target_sources(${PROJECT_NAME} PRIVATE
    src/main.cpp
    main.rc
    cmake/supported_os_win10_win11.manifest
    cmake/long_path_aware.manifest
    cmake/utf_8_active_code_page.manifest
    cmake/dpi_awareness_per_monitor_v2.manifest
)
target_compile_features(${PROJECT_NAME} PRIVATE cxx_std_20)

target_include_directories(${PROJECT_NAME} PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/vendor/include"
    "${CMAKE_CURRENT_BINARY_DIR}/generated/include"
)

target_link_libraries(${PROJECT_NAME} PRIVATE
    fmt::fmt
    spdlog::spdlog
    CLI11::CLI11
    Boost::algorithm
    "ntdll.lib"
)

if (MSVC)
    # target_link_options(${PROJECT_NAME} PRIVATE
    #     "/nodefaultlib:libucrt$<$<CONFIG:Debug>:d>.lib"
    #     "/defaultlib:ucrt$<$<CONFIG:Debug>:d>.lib"
    # )
    target_link_options(${PROJECT_NAME} PRIVATE
        "/manifestuac:level='asInvoker'"
    )
    target_compile_options(${PROJECT_NAME} PRIVATE
        "/utf-8"
    )
endif()


install(TARGETS ${PROJECT_NAME})
install(FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE"
    "${CMAKE_CURRENT_SOURCE_DIR}/README.md"
    DESTINATION "."
)


configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/src/version.hpp.in"
    "${CMAKE_CURRENT_BINARY_DIR}/generated/include/hy_version.hpp"
    @ONLY
)


block()
    set(CPACK_GENERATOR "INNOSETUP")
    set(CPACK_VERBATIM_VARIABLES TRUE)

    set(CPACK_PACKAGE_VENDOR "Hygor Ostrowskij de Morais")
    set(CPACK_PACKAGE_DESCRIPTION "Fixes device enumeration issues and security issues of the Interception Driver")
    set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Provides fixes for Interception Driver issues")
    set(CPACK_PACKAGE_HOMEPAGE_URL "https://github.com/hygorostrowskij/interception-driver-fix")

    set(CPACK_PROJECT_CONFIG_FILE "cpack-config-per-generator.cmake")
    set(CPACK_vcpkg_target_triplet "${VCPKG_TARGET_TRIPLET}")

    set(CPACK_PACKAGE_CHECKSUM "SHA1;SHA256")
    set(CPACK_CREATE_DESKTOP_LINKS "")

    set(CPACK_INNOSETUP_USE_MODERN_WIZARD TRUE)
    set(CPACK_INNOSETUP_SETUP_WizardStyle "modern dynamic")
    set(CPACK_INNOSETUP_SETUP_AppId "{{5379A876-18DC-4531-AD3D-A180C70B7946}")
    set(CPACK_INNOSETUP_SETUP_AppName "Interception Driver Fix")
    set(CPACK_INNOSETUP_SETUP_UninstallDisplayName "${CPACK_INNOSETUP_SETUP_AppName}")
    set(CPACK_INNOSETUP_PROGRAM_MENU_FOLDER "${CPACK_INNOSETUP_SETUP_AppName}")

    set(CPACK_PACKAGE_INSTALL_DIRECTORY "Interception Driver Fix")
    set(CPACK_INNOSETUP_INSTALL_ROOT "{autopf}")

    set(CPACK_INNOSETUP_SETUP_LicenseFile "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")

    configure_file(
        "${CMAKE_CURRENT_SOURCE_DIR}/inno_config.iss.in"
        "${CMAKE_CURRENT_BINARY_DIR}/inno_config.iss.in"
        @ONLY
    )
    file(GENERATE
        OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/inno_config.iss"
        INPUT  "${CMAKE_CURRENT_BINARY_DIR}/inno_config.iss.in"
    )

    set(CPACK_INNOSETUP_EXTRA_SCRIPTS "${CMAKE_CURRENT_BINARY_DIR}/inno_config.iss")
    set(CPACK_INNOSETUP_CODE_FILES "${CMAKE_CURRENT_SOURCE_DIR}/inno_main.iss")


    block()
        set(HY_APP_ICON "${CMAKE_CURRENT_SOURCE_DIR}/assets/chip.ico")
        set(HY_FILE_DESCRIPTION "${CPACK_PACKAGE_DESCRIPTION_SUMMARY}")
        set(HY_INTERNAL_NAME "$<TARGET_FILE_BASE_NAME:${PROJECT_NAME}>")
        set(HY_ORIGINAL_FILENAME "$<TARGET_FILE_NAME:${PROJECT_NAME}>")
        set(HY_PRODUCT_NAME "${CPACK_INNOSETUP_SETUP_AppName}")
        set(HY_COMPANY_NAME "${CPACK_PACKAGE_VENDOR}")
        set(HY_COPYRIGHT "© 2025 ${CPACK_PACKAGE_VENDOR}")

        string(REPLACE "." ";" HY_VERSION_COMMAS "${PROJECT_VERSION}")
        list(APPEND HY_VERSION_COMMAS 0 0 0 0)
        list(SUBLIST HY_VERSION_COMMAS 0 4 HY_VERSION_COMMAS)
        list(JOIN HY_VERSION_COMMAS "," HY_VERSION_COMMAS)

        configure_file(
            "${CMAKE_CURRENT_SOURCE_DIR}/main.rc.in"
            "${CMAKE_CURRENT_BINARY_DIR}/main.rc.in"
            @ONLY
        )
        file(GENERATE
            OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/main.rc"
            INPUT  "${CMAKE_CURRENT_BINARY_DIR}/main.rc.in"
        )
    endblock()


    include(CPack)
endblock()
