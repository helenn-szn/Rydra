@echo off
REM Starts Rydra with SmartSpectra diagnostics. Leave this window open: it shows what the SDK is doing.
cd /d "%~dp0"
set SMARTSPECTRA_DIAGNOSTICS=1
call npm.cmd start
pause
