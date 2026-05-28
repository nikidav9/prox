@echo off
cd /d "%~dp0"

where node > nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not installed.
    echo Get it from: https://nodejs.org  ^(choose LTS^)
    echo.
    pause
    exit /b 1
)

if not exist node_modules\ws (
    echo Installing ws package...
    npm install ws
    if errorlevel 1 (
        echo Install failed. Check internet and try again.
        pause
        exit /b 1
    )
)

node proxy.js
