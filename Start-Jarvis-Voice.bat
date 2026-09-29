@echo off
title Jarvis - Voice Mode
cd /d "%~dp0"
echo.
echo  ============================================
echo   JARVIS - voice mode
echo  ============================================
echo.
echo  Say "Jarvis" — wait for "I'm listening" — then speak your command.
echo  Or in one breath: "Jarvis, what's on my calendar today?"
echo  You can also TYPE a command and press Enter instead of speaking.
echo  Type exit and press Enter to quit.
cmd /k npm run voice
