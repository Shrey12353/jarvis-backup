@echo off
title Jarvis - Voice Mode
cd /d "%~dp0"
echo.
echo  ============================================
echo   JARVIS - voice mode
echo  ============================================
echo.
echo  Say "Jarvis" then speak your command. Answer spoken back.
echo  You can also TYPE a command and press Enter instead of speaking.
echo  Type exit and press Enter to quit.
echo.
echo  No wake-word key yet? Press Enter, speak, press Enter (push-to-talk).
echo.
cmd /k npm run voice
