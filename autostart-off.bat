@echo off
rem Remove the Startup-folder shortcut. Does not stop a running watcher (use remove.bat).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Antigravity Theme Patch.lnk';" ^
  "if (Test-Path $lnk) { Remove-Item $lnk; Write-Host 'Autostart disabled.' } else { Write-Host 'Autostart was not enabled.' }"
