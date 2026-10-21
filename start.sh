#!/bin/sh
# Starts Reachstack on this computer and opens it in the browser (macOS and Linux; on Windows, double-click
# "Start Reachstack.cmd"). The first start installs what it needs and builds the app. Options, for example:
#   ./start.sh --port 4300     use this port
#   ./start.sh --no-open       don't open the browser
#   ./start.sh --lan           let other devices on your network reach it too (this computer only by default)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Reachstack needs Node.js 22.12 or newer: install the LTS from https://nodejs.org, then start it again."
  echo
  exit 1
fi
exec node tools/start-local.mjs "$@"
