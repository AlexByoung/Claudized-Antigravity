@echo off
rem Add a Startup-folder shortcut that launches the hidden watcher at login.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Antigravity Theme Patch.lnk';" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk);" ^
  "$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe';" ^
  "$s.Arguments = '\"%~dp0watch-hidden.vbs\"';" ^
  "$s.WorkingDirectory = '%~dp0'.TrimEnd('\');" ^
  "$s.Description = 'Antigravity theme patch watcher';" ^
  "$s.Save(); Write-Host ('Autostart enabled: ' + $lnk)"
