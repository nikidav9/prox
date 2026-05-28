@echo off
cd /d "%~dp0"

echo prox - starting...
echo.

where node > nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed.
    echo.
    echo Download from: https://nodejs.org
    echo Choose LTS version, install it, then run start.bat again.
    echo.
    pause
    exit /b 1
)

if not exist node_modules\electron (
    echo First run - installing components, please wait ~1 minute...
    echo.
    npm install
    if errorlevel 1 (
        echo.
        echo ERROR: install failed. Check your internet connection and try again.
        pause
        exit /b 1
    )
    echo.
)

echo Launching app...
npx electron . 2>&1
echo.
echo App exited. If no window appeared, there is an error above.
pause
