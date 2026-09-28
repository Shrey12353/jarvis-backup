@echo off
rem  JARVIS AUTOSTART — runs hidden at Windows boot (Startup folder launcher).
rem  Cleans up leftover copies, starts one server, then opens his chat window.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0data\cleanup-ui.ps1" >nul
set JARVIS_UI_OPEN=0
start "Jarvis" /min cmd /c "npm run ui >> data\ui-boot.log 2>&1"
rem  Give the server ~12s to wake up, then open his window in your browser.
timeout /t 12 /nobreak >nul
start "" http://localhost:3777
exit
