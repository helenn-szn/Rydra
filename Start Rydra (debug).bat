@echo off
REM Starts Rydra with SmartSpectra diagnostics. Leave this window open: it shows what the SDK is doing.
cd /d "%~dp0"
if not exist "node_modules\ffmpeg-static" call npm.cmd install
set SMARTSPECTRA_DIAGNOSTICS=1
call npm.cmd start
pause
