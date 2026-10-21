# How Reachstack is built

Reachstack is one TypeScript repository with three packages (npm workspaces):

| Path | What it is |
|---|---|
| `apps/server` | The API and the background engine: Fastify 5, Drizzle ORM, SQLite through libsql, zod |
| `apps/web` | The web app: React 19, Vite, React Router, TanStack Query, Tailwind CSS 4 |
| `packages/shared` | Code both use: permissions, plans and credit costs, Lead Finder lists (levels, departments, industries…), template helpers, time zones, webhook events, the automation catalog |
| `tools/start-local.mjs` | The one-step launcher behind `Start Reachstack.cmd`, `start.sh` and `npm run local` |
| `tools/dev` | Local stand-ins for outside services and other development helpers |

The server runs TypeScript directly through tsx, so there's no server build step. In production one process serves the
API and the built web app (`apps/web/dist`).

## Server (`apps/server/src`)

- `index.ts` starts the API, and the engine unless `RUN_WORKER_IN_PROCESS=false`; `worker.ts` runs the engine alone.
- `env.ts` reads every setting. `http/` holds the Fastify app, authentication, errors and request helpers. `routes/`
  has one file per area (accounts, campaigns, crm, copilot, lead-finder, website-visitors…), `services/` the business
  logic, `mail/` the mail drivers (IMAP/SMTP, Google and Microsoft sign-in, and the test mailbox driver), `engine/`
  the background loops and `db/schema/` the tables.
- **Database:** one SQLite file, `data/app.db`. Migrations in `apps/server/drizzle/` run at startup.
- **Settings:** `.env` (see `.env.example`). The owner can also set most services in Settings → Installation →
  Services; a value saved there replaces the `.env` value, and secrets are stored encrypted.
- **Authentication:** each route declares what it needs: `config: { auth, perm, write, admin, owner, scope }`. Browser
  sessions use a cookie, and every state-changing `/api/` call from the browser sends the header `x-rs-csrf: 1`. API
  keys (`Authorization: Bearer rs_…`) only reach routes that declare an API `scope` (`resource:action`).
- **Engine loops** (`engine/register.ts`): sending, inbox sync, warmup, webhooks, background jobs, scheduled emails,
  inbox placement, the agents, deliverability checks, Copilot tasks, website visitors, automations, backups,
  reminders and a send watchdog. Add new background work there, not in route files, so it also runs in the separate
  worker. Only one process runs the engine for a database at a time (`engine/lease.ts`); another one stands by and
  takes over if the first stops.
- **Engine status:** each loop records its runs, failures and last error, and a heartbeat saves them every 30
  seconds, so the app shows the engine's health even when it runs as a separate worker.
- **The owner and administrators** (`services/instance.ts`): an installation has one owner (the first account on a
  fresh install). The owner's workspaces are never metered. Administrators (the owner, or people the owner makes
  administrators) manage shared data such as the Lead Finder dataset and look after people; only the owner changes
  installation settings. `npm run owner -- someone@example.com` hands ownership to an existing account.
- **Installation settings** (`services/installation.ts`): who can create an account (`invite` by default, `open` or
  `closed`; the first account can always be made), what other people's new workspaces start with, and which product
  areas are switched on.
- **Security:** secrets in background jobs are encrypted and wiped when the job ends; a mailbox's saved password only
  goes to the server it was entered for; Google and Microsoft sign-in link by account id; private network addresses
  are refused for webhooks in production; every answer gets security headers, and pages refuse to be framed.
- **API:** the web app uses `/api/app/…`; the public REST API is `/api/v2/…` with API keys (Settings → Integrations &
  API). Its reference is at `/developers` on every installation. Open and click tracking live under `/t/`,
  unsubscribe pages under `/u/`, and the MCP server for AI assistants at `/mcp`.

## AI assistants (MCP)

- `routes/mcp.ts` is the MCP server: `POST /mcp`, Streamable HTTP without sessions, answering in JSON. It checks the
  request's Origin (other websites are refused) and the API key, then runs the tools.
- `services/mcp-tools.ts` defines the tools. Each has a zod input (sent to apps as JSON Schema), annotations (read
  only, sends email…) and a `run` that calls the REST API through `app.inject` with the caller's key, so a tool can do
  exactly what that key can and nothing more.
- `tools/mcp.mjs` offers the same tools to apps that start their tools as programs (stdio), and as a command line
  (`tools`, `call`). It needs only Node.js and talks to a running Reachstack.
- `scripts/api-key.ts` (`npm run api-key`) makes a key on the computer Reachstack runs on, for an assistant there.
- [agents.md](agents.md) documents every tool; `test/mcp.test.ts` fails when a tool is missing from it.

## Automations

- **One catalog for both apps:** `packages/shared/src/automations.ts` defines the stored graph (trigger, action,
  condition, delay, paths and join steps), every trigger and action with its fields and output, the warnings shown on
  steps, `{{ }}` references, condition evaluation and auto-layout. The server runs graphs with it; the editor builds
  its forms and previews from it.
- **Server** (`services/automations/`): `triggers.ts` starts runs from events, webhooks, schedules and the Run button;
  `engine.ts` walks each run step by step and keeps every step's input and output, so History can show them and a
  retry resumes at the failed step; `actions.ts` holds the action runners; `scope.ts` stops automations that would set
  each other off in a loop; `ai-build.ts` is "Ask AI".
- **Web** (`pages/app/automations/`): the list, History, and the editor built on React Flow.

## Privacy center

- `privacy_requests` holds opt-outs and data requests, `privacy_suppressions` the addresses that shared Lead Finder
  imports skip, and `abuse_reports` the reported emails (`services/privacy.ts`, `routes/privacy.ts`).
- Opt-outs act at once. Data requests email a single-use link; opening it sends the report and carries out deletions,
  and anything else waits for an administrator in Settings → Installation → Privacy center.
- Unsubscribe links (`/u/:token`, one-click as well) stop a person in that campaign or for everything the sender
  sends.

## Web (`apps/web/src`)

- `router.tsx` holds every route; pages load on demand from `pages/`. Pages for people without an account are in
  `pages/public/` (privacy center, unsubscribe choices, shared campaigns) and `pages/marketing/`.
- `components/ui` is the component kit (Button, Card, DataTable, Callout, Sheet, dialogs…), `components/shell` the app
  frame. `lib/api.ts` wraps fetch (with the CSRF header), `lib/session.tsx` holds the signed-in person and their
  permissions (`useCan`), and `lib/unsaved.ts` guards unsaved changes.
- The path alias `@` means `apps/web/src`.

## Tests

`apps/server/test` has the automated tests (Node's test runner through tsx). `test/helpers/setup.ts` gives each test
file a throwaway data folder and makes any attempt to reach the network fail; `test/helpers/app.ts` drives the real
API without opening a port and keeps a session cookie like a browser.
