@echo off
REM Removes the shortcuts and switches recording off. Recordings in data\ are kept.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
pause
endlocal
