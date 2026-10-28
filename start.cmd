@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1
node scripts\launch.mjs %*
set "launch_exit=%errorlevel%"
if not "%launch_exit%"=="0" pause
exit /b %launch_exit%
