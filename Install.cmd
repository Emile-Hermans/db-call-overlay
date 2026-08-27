@echo off
REM Double-click this file to install DB Call Overlay.
REM It only wraps install.ps1 so Windows does not open the script in an editor.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo Installation did not finish. The message above says why.
  echo.
  pause
)
endlocal
