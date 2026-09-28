@echo off
title Jarvis - Trading System (PAPER)
cd /d "%~dp0"
echo.
echo  ==================================================
echo   JARVIS TRADING - Indian markets (PAPER money)
echo  ==================================================
echo.
echo   1) Today's signals     npm run trade -- signals
echo   2) 2-year backtest     npm run trade -- backtest
echo   3) Governed engine     npm run trade -- engine
echo.
echo  Start with option 3 to watch the Survive/Die governor work.
echo  Real money requires a broker API (Angel One / Zerodha) - ask Jarvis.
echo.
cmd /k npm run trade
