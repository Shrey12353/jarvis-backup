@echo off
title Jarvis - AI Assistant (Web UI)
cd /d "%~dp0"
echo Cleaning up any leftover Jarvis copies (so he never gets stuck busy)...
powershell -NoProfile -ExecutionPolicy Bypass -File "data\cleanup-ui.ps1"
echo.
echo  ============================================
echo   JARVIS - your AI assistant (opening browser)
echo  ============================================
echo.
echo  Leave this window open while you chat. Close it to stop Jarvis.
echo.
cmd /k npm run ui
