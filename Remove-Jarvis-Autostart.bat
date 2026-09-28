@echo off
rem  Removes Jarvis from Windows startup (undo of Install-Jarvis-Autostart.bat).
set "DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Jarvis.vbs"
del "%DEST%" >nul 2>&1
if exist "%DEST%" (
  color 4F
  echo  Could not remove - close any open windows and try again.
) else (
  color 2F
  echo  Done - Jarvis will no longer start with Windows.
  echo  You can still start him anytime with Start-Jarvis-UI.bat
)
echo.
pause
