@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\easy_install_windows.ps1" %*
set "OKF_EXIT=%ERRORLEVEL%"
if not "%OKF_INSTALL_NO_PAUSE%"=="1" pause
exit /b %OKF_EXIT%
