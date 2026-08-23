@echo off
setlocal
title Axonkey - Install Interception driver
set "AXONKEY_SCRIPT=%~dp0scripts\install-driver.ps1"
if not exist "%AXONKEY_SCRIPT%" set "AXONKEY_SCRIPT=%~dp0install-driver.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%AXONKEY_SCRIPT%"
set "AXONKEY_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%AXONKEY_EXIT_CODE%"=="0" (
    echo Driver installation finished. Restart Windows before opening Axonkey.
) else (
    echo Driver installation did not complete. Exit code: %AXONKEY_EXIT_CODE%
)
pause
exit /b %AXONKEY_EXIT_CODE%
