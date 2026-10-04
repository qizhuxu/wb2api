@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo [wb2api] first run: installing dependencies...
  call npm install
  if errorlevel 1 goto fail
)
node menu.mjs
pause
exit /b 0

:fail
echo.
echo [wb2api] npm install failed. Check network / npm registry, then retry.
pause
exit /b 1
