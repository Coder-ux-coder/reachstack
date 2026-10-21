# Running Reachstack on a server

On your own computer, `Start Reachstack.cmd` or `sh start.sh` is all you need. For a team, or to have opens and
clicks tracked, run Reachstack on a server that's always on, at an address like `https://outreach.example.com`.

This guide uses a Linux server with systemd and [Caddy](https://caddyserver.com) for HTTPS. Anything that runs Node.js
and passes requests on works the same way.

## What you need

- A Linux server with **Node.js 22.12 or newer** and git.
- A domain or subdomain pointing at the server (an `A` record).
- Outgoing connections to your mailboxes' servers: IMAP (993) and SMTP (587 or 465).

## 1. Install

Reachstack runs as a user of its own, which owns its folder:

```bash
sudo useradd --system --create-home --home-dir /var/lib/reachstack reachstack
```

```bash
sudo git clone https://github.com/Coder-ux-coder/reachstack.git /opt/reachstack && sudo chown -R reachstack: /opt/reachstack
```

```bash
cd /opt/reachstack && sudo -u reachstack npm ci && sudo -u reachstack npm run build
```

## 2. Settings

Create `/opt/reachstack/.env` (`.env.example` explains every setting):

```bash
NODE_ENV=production
# Caddy, on this server, passes requests on; nobody else reaches the port.
HOST=127.0.0.1
PORT=4000
APP_URL=https://outreach.example.com
# systemd starts it again when it exits, so Settings → Installation can offer "Restart now".
REACHSTACK_SUPERVISOR=systemd
```

Then make it readable by Reachstack only: `sudo chown reachstack: .env && sudo chmod 600 .env`.

System email (for invitations, password resets and notifications), AI, and Google and Microsoft sign-in can go in
`.env` too, or be set later in Settings → Installation → Services.

## 3. Keep it running

`/etc/systemd/system/reachstack.service`:

```ini
[Unit]
Description=Reachstack
After=network-online.target
Wants=network-online.target

[Service]
User=reachstack
WorkingDirectory=/opt/reachstack
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

(If `which npm` shows another path, use that in `ExecStart`.)

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now reachstack
```

Check it with `systemctl status reachstack`, and read its messages with `journalctl -u reachstack -f`.

## 4. HTTPS

With Caddy installed, `/etc/caddy/Caddyfile`:

```
outreach.example.com {
	reverse_proxy 127.0.0.1:4000
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets and renews the certificate by itself. Reachstack trusts the visitor's address passed on by a proxy on the
same machine or a private network; see `TRUST_PROXY` in `.env.example` for other setups.

## 5. Create the owner account

Open `https://outreach.example.com` and create your account straight away: the first account owns the
installation. After that, people need an invitation (Settings → Workspace & members) unless you let anyone sign up in
Settings → Installation → Access & features.

## AI assistants

On a server, assistants on other computers (Claude Code, Claude Desktop, Cursor and others that take an API key) can
use Reachstack too: its MCP server is at `https://outreach.example.com/mcp`. Settings → Integrations & API → AI assistants makes a key and shows the setup for each app
with this address. See [agents.md](agents.md).

## Tracking and sending domains

Open and click tracking uses `APP_URL` unless you set `TRACKING_BASE_URL`, and only works at an address the internet
can reach. Each mailbox can also use a tracking domain of its own: its settings show the DNS record to add. For good
delivery, set up SPF, DKIM and DMARC for each sending domain; Email accounts checks them for you.

## Backups

Settings → Installation → Backups makes complete backups (database, encryption key and files) on a schedule, into
`data/backups/`. Copy them somewhere else too. To restore one, upload it there, or with the service stopped:

```bash
sudo -u reachstack npm run restore -w @reachstack/server -- data/backups/<file>.tar.gz
```

## Updating

```bash
cd /opt/reachstack && sudo -u reachstack git pull && sudo -u reachstack npm ci && sudo -u reachstack npm run build
```

```bash
sudo systemctl restart reachstack
```

Database changes apply when it starts. Make a backup first.

## Optional

- **A separate engine process:** set `RUN_WORKER_IN_PROCESS=false` and run `npm run worker -w @reachstack/server` as a
  second service. Only one process runs the engine at a time; the other stands by.
- **Email verification that asks the receiving server** needs outgoing port 25, which most cloud hosts block:
  `VERIFY_SMTP_PROBE=true`.
- **Billing** with Stripe (`STRIPE_SECRET_KEY`), **calls and text messages** with Twilio, and **website visitor
  identification** with an ipinfo.io token: see `.env.example`.
