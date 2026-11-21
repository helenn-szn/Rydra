@echo off
cd /d "%~dp0"
echo Starting the SmartSpectra test app. Keep this window open and screenshot it after the check.
call npm.cmd run repro
pause
