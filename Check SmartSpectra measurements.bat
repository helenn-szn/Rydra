@echo off
cd /d "%~dp0"
if not exist "node_modules\@smartspectra" call npm.cmd install
echo Checking which measurements SmartSpectra accepts. This takes about a minute.
node tools\sdk-repro\config-check.js > config-check-log.txt 2>&1
type config-check-log.txt
echo.
echo The full log was also saved as config-check-log.txt in this folder.
pause
