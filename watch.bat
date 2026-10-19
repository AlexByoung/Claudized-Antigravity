@echo off
rem Start the background watcher (no console window). Stop it with remove.bat.
start "" /b wscript.exe "%~dp0watch-hidden.vbs"
echo Watcher started. Log: %~dp0watch.log
timeout /t 3 >nul 2>&1
