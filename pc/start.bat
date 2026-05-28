@echo off
cd /d "%~dp0"

echo prox - starting...
echo.

where node > nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed.
    echo Download from: https://nodejs.org  ^(choose LTS^)
    echo Install it, then run start.bat again.
    echo.
    pause
    exit /b 1
)

:install
if not exist node_modules\electron\dist\electron.exe (
    echo Installing components, please wait ~2 minutes...
    echo.
    if exist node_modules\electron rmdir /s /q node_modules\electron
    npm install
    if errorlevel 1 (
        echo.
        echo ERROR: install failed. Check internet and try again.
        pause
        exit /b 1
    )
    echo.
)

if not exist node_modules\electron\dist\electron.exe (
    echo Electron binary missing, retrying download...
    rmdir /s /q node_modules\electron
    npm install electron --save
    echo.
)

echo Launching...
node_modules\electron\dist\electron.exe .
echo.
if errorlevel 1 (
    echo Something went wrong. See error above.
    pause
)
