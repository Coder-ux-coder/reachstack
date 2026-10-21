# Contributing to Reachstack

Bug reports, ideas and pull requests are all welcome. This page covers how to run Reachstack from source, how to
check a change, and the conventions the code follows. [docs/architecture.md](docs/architecture.md) explains how the
pieces fit together.

## Set up

You need Node.js 22.12 or newer.

```bash
npm install
```

```bash
npm run dev
```

The API runs on http://localhost:4000 (restarting when server code changes) and the web app on
http://localhost:5173, which passes `/api`, `/mcp`, `/t/` and `/u/` on to the API. Use 5173 in the browser.

If those ports are taken, start the two halves separately on other ports:

```bash
PORT=4100 APP_URL=http://localhost:4100 WEB_URL=http://localhost:5273 npm run dev -w @reachstack/server
```

```bash
API_URL=http://localhost:4100 npm run dev -w @reachstack/web -- --port 5273 --strictPort
```

- **No API keys needed.** [tools/dev](tools/dev/README.md) has local stand-ins for the AI and the IP lookup service,
  so every feature can be tried without sending anything anywhere.
- **Test mailboxes** (Email accounts → Connect → Test mailboxes) keep their mail in the database. What a recipient's
  address starts with decides what happens: `bounce…@` bounces, `ooo…@` answers out of office, `interested…@` or
  `yes…@` replies with interest, `meeting…@` proposes a time, and `notinterested…@` or `no.…@` declines.
- **Demo data:** Lead Finder → Data source → Load demo data, or `npm run seed:demo` (`-- --companies 300` for another
  size, `-- --workspace "Name" --mailboxes 3` to add test mailboxes to a workspace, `-- --remove` to take it out).
- **A fresh database:** stop the server and move `data/` away (or point `DATA_DIR` elsewhere). The first account
  you create becomes the owner.

## Check a change

```bash
npm run typecheck
```

```bash
npm test
```

`npm test` runs every server test (a few minutes). Each test file runs in its own process with a throwaway
database, and tests can't reach the network or your `data` folder. To run one file:

```bash
cd apps/server && npx tsx --test test/sending.test.ts
```

`npm run build` makes the production build of the web app, which `npm start` and `npm run local` serve.

## Change the database

Edit the tables in `apps/server/src/db/schema/`, then generate a migration and commit it with your change:

```bash
cd apps/server && npx drizzle-kit generate --name describe-the-change
```

Migrations in `apps/server/drizzle/` run by themselves when the server starts.

## Conventions

- **Formatting:** there's no formatter configuration, so match the file you're in (long lines are fine) and don't
  reformat whole files. Files use LF line endings.
- **Routes** validate their input with zod and answer with readable errors, never a bare 500.
- **Background work** goes in an engine loop (`apps/server/src/engine/register.ts`), so it also runs when the engine
  runs as a separate worker.
- **AI assistants' tools** (`apps/server/src/services/mcp-tools.ts`) call the REST API: when an endpoint they use
  changes, check its tool, and list a new tool in [docs/agents.md](docs/agents.md) (a test checks).
- **Tests** come with each change: a test that fails without the change and passes with it.
- **Words on screen** are plain and specific: say what happened and what to do next.
- **Nothing leaves the machine in tests or examples:** use `.test` or `example.com` addresses, the stand-ins in
  `tools/dev`, and webhooks at `http://localhost:4998/hook` or a host that never resolves, like
  `https://hooks.invalid/…`. Never put real passwords, keys or personal data in tests, fixtures or docs.

## Pull requests

Keep each pull request to one topic, say what changes for the people using Reachstack, and run the typecheck and the
tests before you open it.

## Security issues

Please don't open a public issue for a security problem: see [SECURITY.md](SECURITY.md).
