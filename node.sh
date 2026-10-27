#!/bin/sh
# Run a script with Node >= 22 (macOS). Used by watch.sh, inject.sh, remove.sh.
#
# Order: $AG_NODE, then `node` on PATH if it is 22 or newer, else the Node
# that ships inside Antigravity (Electron run as plain Node), so nothing needs
# to be installed.
APP="${AG_APP:-/Applications/Antigravity.app}"

if [ -n "$AG_NODE" ]; then
  exec "$AG_NODE" "$@"
fi

# launchd starts with a bare PATH; add the usual Homebrew / nvm-less spots
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  if [ "${major:-0}" -ge 22 ]; then
    exec node "$@"
  fi
fi

if [ -x "$APP/Contents/MacOS/Antigravity" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$APP/Contents/MacOS/Antigravity" "$@"
fi

echo "[!] 需要 Node.js 22+，或安装在 $APP 的 Antigravity（可用 AG_APP 指定路径）" >&2
exit 1
