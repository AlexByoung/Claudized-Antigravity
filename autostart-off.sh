#!/bin/sh
# Remove the login LaunchAgent. Does not stop a running watcher (use remove.sh).
PLIST="$HOME/Library/LaunchAgents/com.claudized-antigravity.watch.plist"
if [ -f "$PLIST" ]; then
  rm "$PLIST"
  echo "Autostart disabled."
else
  echo "Autostart was not enabled."
fi
