@echo off
REM Double-click to start Rydra. Uses your .env file for the API key.
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing packages, this takes a few minutes...
  call npm.cmd install
)
call npm.cmd start
