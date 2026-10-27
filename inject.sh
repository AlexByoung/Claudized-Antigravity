#!/bin/sh
# One-shot injection (lost on window reload; for debugging).
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/node.sh" "$DIR/inject.js"
