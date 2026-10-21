#!/usr/bin/env bash
# End-to-end smoke test against a running local server (dev only). Run from the repo root:
#   bash tools/dev/smoke.sh
# Expects: the API on $API (default http://localhost:4000) started with
#   ANTHROPIC_BASE_URL=http://localhost:4999 ANTHROPIC_API_KEY=test-key IPINFO_BASE_URL=http://localhost:4998
# plus both stand-ins from tools/dev/mock running. SMOKE_EMAIL and SMOKE_PASSWORD: an account on that server.
# The website visitor checks run when the workspace has a site, with the IP lookup token test-ipinfo saved.
# Each run adds one test visit and creates then deletes one API key (both show in the audit log).
API="${API:-http://localhost:4000}"
# Windows-style path under Git Bash (pwd -W) so native curl/node can open files in it.
DIR="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
export JAR="$DIR/.smoke-cookies"
rm -f "$JAR"
EMAIL="${SMOKE_EMAIL:?Set SMOKE_EMAIL and SMOKE_PASSWORD to an account on the server you're testing}"
PASSWORD="${SMOKE_PASSWORD:?Set SMOKE_EMAIL and SMOKE_PASSWORD to an account on the server you're testing}"
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1: $2"; fail=$((fail + 1)); }
call() { API="$API" bash "$DIR/api.sh" "$@"; }
# Reads a value out of JSON on stdin: json '.items.length'
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const v=new Function("o","return o"+process.argv[1])(o);console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)}catch(e){console.log("")}})' "$1"; }

r=$(curl -s -o /dev/null -w '%{http_code}' "$API/")
[ "$r" = "200" ] && ok "server answers on $API" || bad "server answers on $API" "HTTP $r"

r=$(call POST /api/app/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
[ -n "$(echo "$r" | json '.session_id')" ] && ok "sign in" || bad "sign in" "$r"

ws=$(call GET /api/app/auth/me | json '.workspace.name')
[ -n "$ws" ] && ok "current workspace: $ws" || bad "current workspace" "no workspace in /me"

n=$(call GET /api/app/campaigns | json '.items.length')
[ -n "$n" ] && ok "campaign list ($n campaigns)" || bad "campaign list" "no items"

r=$(call POST /api/app/ai/test)
[ "$(echo "$r" | json '.ok')" = "true" ] && ok "AI call through ANTHROPIC_BASE_URL ($(echo "$r" | json '.model'))" || bad "AI call" "$r"

r=$(call POST /api/v2/api-keys '{"name":"smoke test","scopes":["campaigns:read"]}')
key=$(echo "$r" | json '.key'); kid=$(echo "$r" | json '.id')
if [ -n "$key" ]; then
  n=$(curl -s -H "Authorization: Bearer $key" "$API/api/v2/campaigns?limit=1" | json '.items.length')
  [ -n "$n" ] && ok "public API v2 with a bearer API key" || bad "public API v2" "no items"
  r=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" "$API/api/v2/api-keys")
  [ "$r" = "403" ] && ok "API key scopes enforced (HTTP 403 outside its scope)" || bad "API key scopes" "HTTP $r"
  call DELETE "/api/v2/api-keys/$kid" > /dev/null
else
  bad "create API key" "$r"
fi

sites=$(call GET /api/app/website-visitors/sites)
pixel=$(echo "$sites" | json '.items[0].pixel_key')
if [ -n "$pixel" ]; then
  v="v-smoke-$(date +%s)"
  # MSYS_NO_PATHCONV stops Git Bash rewriting "/smoke-test" into a Windows path.
  MSYS_NO_PATHCONV=1 node "$DIR/wvsim2.mjs" "$pixel" "$v" 203.0.113.11 /smoke-test > /dev/null
  r=$(call POST /api/app/website-visitors/identify '{"limit":10}')
  st=$(node "$DIR/dbq.mjs" "select resolve_status, company_domain from visitor_sessions where visitor_key = '$v'" 2>&1 | grep -o "'[a-z_]*' *│ *'[a-z.]*'" | head -1)
  echo "$st" | grep -q "junloop.test" && ok "website visit identified through IPINFO_BASE_URL ($st)" || bad "website visit identified" "status: ${st:-none}; identify said $r"
  r=$(call POST /api/app/website-visitors/views/test '{"name":"Smoke test","destinations":{"webhook_url":"http://localhost:4998/hook"}}')
  echo "$r" | grep -q '"ok":true' && ok "visitor alert webhook delivered to the local receiver" || bad "visitor alert webhook" "$r"
else
  echo "SKIP  website visitors: no site set up in this workspace"
fi

rm -f "$JAR"
echo "---- $pass passed, $fail failed"
[ "$fail" = "0" ]
