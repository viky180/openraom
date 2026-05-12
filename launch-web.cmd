@echo off
cd /d "%~dp0"
for /f %%P in ('powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique"') do taskkill /PID %%P /F >nul 2>nul
start "Local Roam Web Server" /min cmd /c "npm run web"
timeout /t 2 /nobreak >nul
start "" chrome.exe "http://127.0.0.1:3100"
