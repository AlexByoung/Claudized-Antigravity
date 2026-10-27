#!/bin/sh
# Start the background watcher (macOS). Stop it with remove.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
nohup "$DIR/node.sh" "$DIR/inject.js" --watch >/dev/null 2>&1 &
echo "Watcher started. Log: $DIR/watch.log"
