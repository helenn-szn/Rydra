@echo off
cd /d "%~dp0"
if not exist "node_modules\.bin\esbuild.cmd" (
  echo Installing the parts the app needs. This takes a few minutes the first time...
  call npm.cmd install
)
echo Starting the SmartSpectra test app. Keep this window open and screenshot it after the check.
call npm.cmd run repro
pause
