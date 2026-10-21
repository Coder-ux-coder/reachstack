#!/usr/bin/env bash
# Calls the local API with a saved session cookie (dev only).
# usage: bash tools/dev/api.sh METHOD PATH [JSON]
#   bash tools/dev/api.sh POST /api/app/auth/login '{"email":"<test email>","password":"<test password>"}'
#   bash tools/dev/api.sh GET /api/app/campaigns
# Env: API (default http://localhost:4000), JAR (cookie file, default tools/dev/.cookies; never commit it).
# Git Bash on Windows rewrites arguments that look like paths: prefix calls with MSYS_NO_PATHCONV=1 if a path breaks.
API="${API:-http://localhost:4000}"
JAR="${JAR:-$(dirname "$0")/.cookies}"
M="$1"; P="$2"; D="$3"
if [ -n "$D" ]; then
  curl -s -X "$M" -c "$JAR" -b "$JAR" -H 'x-rs-csrf: 1' -H 'content-type: application/json' --data "$D" "$API$P"
else
  curl -s -X "$M" -c "$JAR" -b "$JAR" -H 'x-rs-csrf: 1' "$API$P"
fi
echo
