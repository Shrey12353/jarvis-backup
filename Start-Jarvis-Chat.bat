@echo off
title Jarvis - Chat Mode
cd /d "%~dp0"
echo.
echo  ============================================
echo   JARVIS - your local AI agent (chat mode)
echo  ============================================
echo.
echo  First time? Do these once (press Ctrl+C to cancel, then double-click again):
echo    1. GitHub:   gh auth login        (choose GitHub.com, Login with a web browser)
echo    2. Vercel:   vercel login         (opens your browser)
echo    3. Supabase: supabase login       (opens your browser)
echo  Skip any you do not need. The agent will use whatever is logged in.
echo.
echo  In the chat you can type /tools to see everything Jarvis can do.
echo.
cmd /k npm run chat
