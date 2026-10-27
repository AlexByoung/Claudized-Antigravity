#!/bin/sh
# Stop the watcher, close the Gemini window and undo every injection.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/node.sh" "$DIR/remove.js" "$@"
