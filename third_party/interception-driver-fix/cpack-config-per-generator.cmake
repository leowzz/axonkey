string(TOLOWER "${CPACK_BUILD_CONFIG}" _build_type)
set(CPACK_PACKAGE_FILE_NAME "${CPACK_PACKAGE_NAME}-v${CPACK_PACKAGE_VERSION}-${CPACK_vcpkg_target_triplet}-${_build_type}")
