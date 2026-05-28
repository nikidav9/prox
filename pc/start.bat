@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo prox — запуск...
echo.

where node > nul 2>&1
if errorlevel 1 (
    echo ОШИБКА: Node.js не установлен.
    echo.
    echo Скачай с сайта: https://nodejs.org
    echo Выбери LTS версию, установи, затем запусти start.bat снова.
    echo.
    pause
    exit /b 1
)

if not exist node_modules\electron (
    echo Первый запуск — установка компонентов ~1 минута...
    echo.
    npm install
    if errorlevel 1 (
        echo.
        echo ОШИБКА при установке. Проверь интернет и попробуй снова.
        pause
        exit /b 1
    )
    echo.
)

npx electron .
