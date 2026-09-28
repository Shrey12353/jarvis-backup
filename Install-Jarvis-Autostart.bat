@echo off
rem  ONE-TIME SETUP: make Jarvis start silently with Windows.
rem  No admin needed. Undo anytime with Remove-Jarvis-Autostart.bat
set "DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Jarvis.vbs"
del "%DEST%" >nul 2>&1
echo Set sh = CreateObject("WScript.Shell") > "%DEST%"
echo sh.Run """%~dp0jarvis-autostart.bat""", 0, False >> "%DEST%"
if not exist "%DEST%" (
  color 4F
  echo  SETUP FAILED - could not write to the Startup folder.
  pause
  exit /b 1
)
color 2F
echo.
echo  ============================================================
echo   SUCCESS - Jarvis will now start silently with Windows
echo  ============================================================
echo.
echo  Next reboot: he starts in the background all by himself and
echo  his chat window opens automatically. No double-clicking.
echo.
echo  To undo later: double-click Remove-Jarvis-Autostart.bat
echo.
pause
