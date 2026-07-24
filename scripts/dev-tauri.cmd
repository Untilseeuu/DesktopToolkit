@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64
set "PATH=C:\Users\64173\.cargo\bin;D:\Programming\node-v24.3.0-win-x64;%PATH%"
cd /d "D:\Programming\1Code\MyWork\DesktopToolkit"
"D:\Programming\node-v24.3.0-win-x64\npm.cmd" run tauri dev
