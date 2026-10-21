# Dev tools

Helpers used while building and testing. None of them are part of the product, and none talk to real
third-party services: the stand-ins replace the Anthropic API and ipinfo.io on your own machine.

Run everything from the repo root. Commands are written for Git Bash (Windows) or any POSIX shell.

## Check that a fresh copy starts

```bash
node tools/dev/first-start.mjs
```

Starts Reachstack the way someone who just downloaded it does (`start.sh`, or `Start Reachstack.cmd` on Windows) on
port 4600 with a new, empty data folder: it installs what's missing and builds the web app first, which takes a few
minutes in a fresh copy. Then it makes the owner account and an API key, connects test mailboxes through the MCP tools,
launches a campaign and waits for its emails and a reply, runs `node tools/mcp.mjs` and `npm run api-key`, and stops
everything. It ends with `First start check passed`. GitHub runs it on Linux, macOS and Windows for every change
(`--port` picks another port).

## Test without real API keys (3 terminals)

```bash
node tools/dev/mock/anthropic-mock.mjs tools/dev/mock/requests.log 4999
```

```bash
node tools/dev/mock/ipinfo-mock.mjs 4998
```

```bash
ANTHROPIC_BASE_URL=http://localhost:4999 ANTHROPIC_API_KEY=test-key IPINFO_BASE_URL=http://localhost:4998 npm run dev
```

Then, in a fourth terminal:

```bash
SMOKE_EMAIL=you@example.test SMOKE_PASSWORD=… bash tools/dev/smoke.sh
```

`smoke.sh` signs in with that account (make one first on a fresh database), lists campaigns, makes one AI call
through the stand-in, creates an API key, calls the public API v2 with it, checks scopes are enforced, deletes the
key, and, when the workspace has a website set up (Website visitors → Setup, with the IP lookup token `test-ipinfo`
saved), sends one simulated visit, identifies it through the IP lookup stand-in and delivers a test visitor alert to
the stand-in's webhook receiver. Expected result: `9 passed, 0 failed` (`7 passed` without a website).

If ports 4000 or 5173 are taken, start the two halves on other ports (with the stand-in settings above on the API
command), then point the smoke test at the API:

```bash
PORT=4100 APP_URL=http://localhost:4100 WEB_URL=http://localhost:5273 npm run dev -w @reachstack/server
```

```bash
API_URL=http://localhost:4100 npm run dev -w @reachstack/web -- --port 5273 --strictPort
```

```bash
API=http://localhost:4100 SMOKE_EMAIL=you@example.test SMOKE_PASSWORD=… bash tools/dev/smoke.sh
```

## Files

| File | What it does |
|---|---|
| `mock/anthropic-mock.mjs` | Stand-in for `POST /v1/messages`. Answers each AI feature with a canned, schema-shaped reply (reply drafts, labels, research openers, sequences, spam findings, Lead Finder filters, audience suggestions, follow-ups, automation drafts from "Ask AI", and the fields an automation's Ask AI step returns) and streams Copilot turns (with `mock/copilot.mjs`). Optional first argument: a log file that records every request body (prompts included; `*.log` is gitignored). |
| `mock/copilot.mjs` | Copilot streaming script used by the AI stand-in: picks a tool call or an answer from the newest user message and streams it as server-sent events. |
| `mock/ipinfo-mock.mjs` | Stand-in for the IP lookup API. Only accepts the token `test-ipinfo`. Knows the `203.0.113.x` documentation addresses used by the visit simulators (business, ISP, hosting, privacy and "network owner only" answers). `POST /hook` prints webhook bodies, so views and integrations can be tested against `http://localhost:4998/hook`. |
| `mock/check-ai.ts` | Classifies one reply with the configured AI: `npx tsx tools/dev/mock/check-ai.ts <workspaceId> ["reply text"]` (same environment as the server). |
| `mock/check-inbox-manager.mts` | Runs one Inbox Manager pass for an agent and prints its drafts and events: `npx tsx tools/dev/mock/check-inbox-manager.mts <agentId>`. |
| `mock/check-lfa.mts` | Forces one Lead Finder Agent check and prints events and the leads it added: `npx tsx tools/dev/mock/check-lfa.mts <agentId> <campaignId>`. |
| `smoke.sh` | End-to-end smoke test described above. |
| `api.sh` | Calls the local API with a saved session cookie: `bash tools/dev/api.sh POST /api/app/auth/login '{"email":"…","password":"…"}'`, then `bash tools/dev/api.sh GET /api/app/campaigns`. Cookie file: `tools/dev/.cookies` (gitignored; never share it). |
| `dbq.mjs` | Runs SQL against `data/app.db` and prints up to 40 rows: `node tools/dev/dbq.mjs "select email from users"`. It can write too, so stop the server before any change you are unsure about. |
| `wvsim.mjs` | Simulates website visitor snippet traffic: `node tools/dev/wvsim.mjs <pixelKey> all` (or `rejects`, `test`, `conflict`). The pixel key is on Website visitors → Setup → See code. |
| `wvsim2.mjs` | Sends a single pageview: `MSYS_NO_PATHCONV=1 node tools/dev/wvsim2.mjs <pixelKey> <visitorKey> 203.0.113.16 /pricing`. |

## Notes

- The visit simulators send a browser user agent on purpose: requests from `curl/…` or bot user agents are dropped as bots.
- Git Bash rewrites arguments that start with `/` into Windows paths when it starts a native program (node, curl).
  Prefix such commands with `MSYS_NO_PATHCONV=1`.
- Keep test webhooks on `http://localhost:4998/hook` or a non-resolving host such as `https://hooks.invalid/…`, so nothing leaves the machine.
- The stand-ins are deliberately simple. When a feature sends a new structured-output schema, teach
  `anthropic-mock.mjs` the new shape (it dispatches on the schema's property names).
