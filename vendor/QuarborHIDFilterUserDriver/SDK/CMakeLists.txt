cmake_minimum_required(VERSION 3.20)
project(QuarborHidUserClient LANGUAGES C CXX)
if(NOT WIN32)
  message(FATAL_ERROR "The named-pipe client requires Windows.")
endif()
add_library(quarbor_hid_user_client STATIC
  src/ReportClient.cpp src/QuarborHidUserCodec.cpp generated/hid_user.pb.c
  nanopb/pb_common.c nanopb/pb_encode.c nanopb/pb_decode.c)
target_include_directories(quarbor_hid_user_client PUBLIC include PRIVATE generated nanopb)
target_compile_features(quarbor_hid_user_client PUBLIC cxx_std_17)
if(MSVC)
  target_compile_options(quarbor_hid_user_client PUBLIC /utf-8)
endif()
target_compile_definitions(quarbor_hid_user_client PUBLIC
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_link_libraries(quarbor_hid_user_client PRIVATE kernel32)
