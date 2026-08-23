@echo off
setlocal
title Axonkey - Remove Interception driver
set "AXONKEY_SCRIPT=%~dp0scripts\uninstall-driver.ps1"
if not exist "%AXONKEY_SCRIPT%" set "AXONKEY_SCRIPT=%~dp0uninstall-driver.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AXONKEY_SCRIPT%"
set "AXONKEY_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%AXONKEY_EXIT_CODE%"=="0" (
    echo Driver removal finished. Restart Windows to finish removal.
) else (
    echo Driver removal did not complete. Exit code: %AXONKEY_EXIT_CODE%
)
pause
exit /b %AXONKEY_EXIT_CODE%
