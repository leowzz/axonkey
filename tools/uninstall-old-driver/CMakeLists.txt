cmake_minimum_required(VERSION 3.20)

project(uninstall-old-driver LANGUAGES CXX)

add_executable(uninstall-old-driver WIN32 src/main.cpp)
target_compile_features(uninstall-old-driver PRIVATE cxx_std_20)
target_compile_definitions(uninstall-old-driver PRIVATE UNICODE _UNICODE _WIN32_WINNT=0x0A00)
target_compile_options(uninstall-old-driver PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/utf-8>)
target_link_libraries(uninstall-old-driver PRIVATE advapi32 comctl32 shell32 uxtheme)
target_link_options(uninstall-old-driver PRIVATE $<$<CXX_COMPILER_ID:GNU>:-municode>)

set_target_properties(uninstall-old-driver PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/bin/Release"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_SOURCE_DIR}/bin/Debug"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_SOURCE_DIR}/bin/Release"
)
