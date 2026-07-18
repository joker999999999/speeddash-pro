@echo off
title SpeedDash Pro
setlocal

set "NODEJS_DIR=C:\Program Files\nodejs"
set "NPM_CMD=npm"
if exist "%NODEJS_DIR%\npm.cmd" (
    set "PATH=%NODEJS_DIR%;%PATH%"
    set "NPM_CMD=%NODEJS_DIR%\npm.cmd"
)

echo.
echo ====================================
echo   SpeedDash Pro - Launcher
echo ====================================
echo.

echo Выберите режим запуска:
echo [1] Web (рекомендуется: платежи, PWA, шаринг)
echo [2] Desktop (Electron)
set /p MODE=Введите 1 или 2: 

if not exist node_modules (
    echo Installing dependencies...
    call "%NPM_CMD%" install
    echo.
)

if "%MODE%"=="2" (
    echo Starting SpeedDash Pro Desktop...
    call "%NPM_CMD%" start
) else (
    echo Starting SpeedDash Pro Web...
    call "%NPM_CMD%" run web
)

pause
