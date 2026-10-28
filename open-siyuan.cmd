@echo off
setlocal
set "siyuan_exe=%LOCALAPPDATA%\Programs\SiYuan\SiYuan.exe"
set "siyuan_workspace=%~dp0runtime\zhixing1c2af369"
if not exist "%siyuan_exe%" (
  echo SiYuan is not installed at the configured location.
  exit /b 1
)
if not exist "%siyuan_workspace%\" (
  echo The dedicated SiYuan workspace is missing. No workspace was created.
  exit /b 1
)
start "" "%siyuan_exe%" "--workspace=%siyuan_workspace%" "--port=19006"
exit /b %errorlevel%
