@echo off
cd /d "%~dp0"
rem Uses the older in-window camera setup instead of the background camera engine.
set MZ_ENGINE=window
set SMARTSPECTRA_DIAGNOSTICS=1
call npm.cmd start
pause
