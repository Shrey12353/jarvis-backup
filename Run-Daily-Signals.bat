@echo off
rem Run-Daily-Signals.bat — launched by Windows Task Scheduler every trading morning.
rem Writes a dated report to C:\Users\shrey\jarvis-workspace\reports\
cd /d "C:\Users\shrey\Downloads\AI"
if not exist "node_modules" (
  echo Node modules missing - run npm install once in this folder.
  exit /b 1
)
npm run trade -- daily
