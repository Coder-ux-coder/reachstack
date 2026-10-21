# How Reachstack works, and how to make it yours

This guide explains what Reachstack does behind its pages and how to change it to suit you. It's written for the
people who run it and for the AI assistants that help them. To install it, see the [README](../README.md). The AI
assistants' tools are in [agents.md](agents.md), the layout of the code is in [architecture.md](architecture.md),
and running it on a server is in [self-hosting.md](self-hosting.md).

**Contents**

1. [The pieces](#1-the-pieces)
2. [A campaign email, from launch to reply](#2-a-campaign-email-from-launch-to-reply)
3. [Mailboxes and deliverability](#3-mailboxes-and-deliverability)
4. [Replies and the Unibox](#4-replies-and-the-unibox)
5. [Leads, lists and the CRM](#5-leads-lists-and-the-crm)
6. [Lead Finder](#6-lead-finder)
7. [AI](#7-ai)
8. [Automations, webhooks and the API](#8-automations-webhooks-and-the-api)
9. [People, workspaces and agencies](#9-people-workspaces-and-agencies)
10. [Safety nets](#10-safety-nets)
11. [Make it yours](#11-make-it-yours)
12. [Changing the code](#12-changing-the-code)
13. [Limits, and what has been tested](#13-limits-and-what-has-been-tested)

## 1. The pieces

**One program.** Reachstack is a single Node.js server that does three jobs at once: it answers the web app, it serves
the API, and it runs the *engine*, the background work that sends emails, checks inboxes and keeps everything moving.
`Start Reachstack.cmd`, `sh start.sh` and `npm run local` all start it the same way, on your own computer. On a
server it runs with `npm start` (see [self-hosting.md](self-hosting.md)), and the engine can also run as a separate
process (`npm run worker -w @reachstack/server`, with `RUN_WORKER_IN_PROCESS=false` for the server).

**One folder of data.** Everything Reachstack knows is in the `data` folder (or wherever `DATA_DIR` points):

| What | What it is |
|---|---|
| `app.db` | The database (SQLite): workspaces, people, mailboxes, campaigns, leads, emails, settings, everything |
| `secret.key` | The key that encrypts saved passwords and tokens. Keep it with `app.db`: without it they can't be read |
| `attachments/`, `uploads/`, `exports/` | Files from emails, imported files and exports people asked for |
| `backups/` | Scheduled and manual backups, and what a restore replaced |
| `local-server.json` | Where the launcher started it (port and address); assistants' tools read it |
| `agent-api-key` | An AI assistant's key, when `npm run api-key -- --save` made one |

Copying the whole folder (with Reachstack stopped) moves the installation to another computer.

**The engine.** Each kind of background work is a loop that runs every few seconds or minutes:

| Loop | How often | What it does |
|---|---|---|
| sender | 5 s | Sends campaign and subsequence emails that are due |
| inbox-sync | 10 s | Reads each mailbox that's due: real ones every minute, test mailboxes every 15 s |
| warmup | 1 min | Sends and answers warmup emails |
| jobs | 2 s | Background jobs: imports, exports, enrichment, bulk changes |
| webhooks, automations | 3–5 s | Delivers webhooks and runs automation steps |
| scheduled-emails, reminders | 15–30 s | Unibox emails sent later, and reminders that come due |
| inbox-manager, sales-agent | 15–20 s | The AI agents |
| placement, deliverability | 3 s – 1 min | Inbox placement tests, spam and DNS checks |
| send-watchdog | 2 min | Notices a campaign that should be sending but isn't |
| backups | 1 min | Makes scheduled backups when they're due |
| domain-dns, tracking-domains | 1 h | Re-checks sending domains' DNS and custom tracking domains |
| recently-deleted, webhook-log | daily | Empties things kept for 30 days |

Only one process runs the engine for a database at a time. It holds a lease that it renews every 15 seconds; a second
server or worker on the same data waits on standby and takes over if the first one stops. Settings → Installation →
Overview shows each loop's last run, its failures and its last error.

**Workspaces.** Mailboxes, campaigns, leads and replies all belong to a workspace. People are members of workspaces
with a role, and one person owns the whole installation (the first account). An agency can run a workspace per
client.

**Four ways in,** all with the same rules about who may do what: the web app; the REST API (`/api/v2/…`, with API
keys, documented at `/developers` on every installation); the MCP server (`/mcp`) for AI assistants; and the command
line in `tools/mcp.mjs`, which runs the same tools as the MCP server.

**Your own computer or a server.** On your own computer, Reachstack is only reachable from that computer (start it
with `--lan` for other devices on your network). People you email can't reach it either, so on a computer:

- links in emails stay as written, and opens and clicks aren't counted;
- `{{unsubscribe_url}}` becomes an email link: the person sends an email to unsubscribe, and that unsubscribes them.

Sending, replies, bounces, warmup and everything else work the same. To count opens and clicks, run it on a server
with a public HTTPS address.

## 2. A campaign email, from launch to reply

### Launching

**Launch** runs two kinds of check. These stop a launch: no steps, an email step where no version has a body, no
subject on the first email, unbalanced `{{ }}` braces, and no mailbox to send from. These are warnings, shown before
you confirm (and by the `check_campaign` tool):

- no leads; `{{variables}}` that no lead has; mailboxes without a sender name;
- broken or placeholder links; no way to opt out in any email;
- less than 5 minutes between emails; a daily limit the mailboxes can't reach;
- mailboxes connected and warmed up for less than 14 days;
- tracking that the internet can't reach;
- the worst email a lead would get, with personalization that's missing for some leads.

### When an email goes out

Every 5 seconds the sender looks at each running campaign. An email goes out when all of these hold:

- **The schedule is open.** A schedule has days, hours (`from` and `to`, on a 24-hour clock) and a time zone; it can
  also skip public holidays and chosen dates, and start or end on a date. With "each lead's timezone" on, the hours
  are read on each lead's own clock where it's known. New campaigns start on the workspace's time zone.
- **A mailbox is ready.** Each mailbox sends at most its *daily limit* (30 by default; it counts the same address's
  sends from every workspace). After each email it waits the gap: the larger of the campaign's and the mailbox's gap
  (10 minutes each by default), plus a random 0–10 minutes so the timing doesn't look automated. A mailbox with slow
  ramp-up starts at 10 a day and adds 10 each day.
- **The campaign has room.** The campaign's own daily limit (50 by default, across its mailboxes) and its limit of new
  leads a day, if set. With the campaign's slow ramp-up it sends 20 on launch day and 20 more each day after.
- **A lead is due.** Follow-ups go first (the longest-waiting first), then people who haven't had an email yet, the
  earliest added first; "prioritize new leads" puts new people before follow-ups. Daily limits reset at midnight on
  the workspace's clock.

Each mailbox sends at most one email per pass, so a campaign with three mailboxes sends up to three emails at a time
and then waits for the gaps.

**Who is skipped:** people on the blocklist (address or domain), people who unsubscribed or bounced anywhere in the
workspace, addresses that email verification found invalid (and risky ones, unless allowed), and people at a company
that has had its emails for the day when the workspace limits emails per company. Addresses on `.test` and other
reserved domains only go to test mailboxes. Just before a follow-up, Reachstack checks once more for a reply.

**Which mailbox sends:** follow-ups always come from the mailbox that sent the first email, so they stay in one
thread. For a new lead, routing rules come first; then "match the lead's provider" (Google to Google, Microsoft to
Microsoft), when it's on; then the mailbox with the most room left today.

### What's in the email

- **Variables** fill in per lead (`{{firstName}}`, `{{companyName}}`, your own fields…) and per mailbox
  (`{{sendingAccountFirstName}}`, `{{accountSignature}}`). `{{firstName | there}}` falls back to "there";
  `{{RANDOM | Hi | Hello}}` picks one per email. The signature only appears where `{{accountSignature}}` is. An email
  that would come out blank isn't sent: the lead is paused instead, and the campaign shows why.
- **A/B versions** of a step take turns. With "pick the winner" on, once every version has 50 sends and they have 5
  replies (or clicks or opens) between them, 9 in 10 emails go to the best one and 1 in 10 keeps testing the others.
- **Threads:** a follow-up with an empty subject is sent as "Re: …" in the same thread; one with its own subject
  starts a new thread.
- **Plain text:** "text only" sends every email as plain text, without tracking.
- **Tracking** (both off by default): opens with a tiny image, clicks by sending links through Reachstack. Visits from
  bots and mail scanners, and those in the first seconds after sending, don't count.
- **Unsubscribing:** `{{unsubscribe_url}}` is a link to a page where the person unsubscribes from this campaign or
  from everything. The *unsubscribe header* lets people unsubscribe from their mail app in one click (Gmail and Yahoo
  look for it from anyone sending a lot): it's in Options as "Insert unsubscribe link header", off by default for
  campaigns made in the app and on for campaigns AI assistants make.

### Sending

Every mailbox sends through its own SMTP server; Google and Microsoft mailboxes connected by signing in use the same
route with a token instead of a password. Test mailboxes write the email into the database instead. When a send fails:

- a temporary refusal from the recipient's server is tried again a day later, and the third one counts as a bounce;
- a problem with the mailbox itself (sign-in, connection, quota) pauses that mailbox's sending for 15 minutes (6 hours
  for quota or a refusal), and the mailbox page says what's wrong;
- anything else is tried again after 30 minutes, then an hour, and so on, up to a day.

**Bounce protection:** when a campaign has tried at least 200 emails in 7 days and 5% or more bounced, it pauses itself
(the threshold is a workspace setting, 1–20%). Resuming it gives it 7 days' grace. The **send watchdog** notices a
campaign that has had an open schedule and leads due for an hour without sending anything, marks it "Stalled" and
tells you once.

### After it's sent

**Inbox sync** reads each mailbox's inbox, spam folder and (for Gmail) All Mail every minute. An incoming email is
matched to the email it answers by its headers, or else to a lead by the sender's address. Then:

- **A reply** stops the lead in that campaign (with "stop on reply", on by default), and in the workspace's other
  campaigns too (a workspace setting, on by default). "Stop for the whole company" can also stop their colleagues.
- **A request to stop** ("stop", "remove me", "unsubscribe", an unsubscribe email) unsubscribes the person and, by
  default, adds them to the blocklist.
- **An out-of-office reply** doesn't count as a reply. That person's emails wait until the day after their return
  date (7 days when there's no date, 30 at most), or stop, if the campaign stops on automatic replies.
- **A bounce notice** marks the address bounced in every campaign of the workspace, and it won't be emailed again.
- **Labels:** with "Automatically label replies" on (Settings → Preferences), each reply gets an interest label:
  interested, meeting booked, not interested, wrong person, out of office… The AI chooses when one is set up;
  otherwise built-in rules do. People can always set labels by hand, and add their own.
- **Subsequences** start for a lead when their label changes to one you chose, when they open, click or finish the
  sequence without replying, or when their reply contains certain words.
- **Webhooks and automations** react to every one of these events.

A campaign is **completed** when it has no active or paused leads left (unless it's kept stocked by an agent). Leads
added to a completed campaign wait until you resume it.

### Analytics

Counts come from the events each email produces: sent, opened, clicked, replied, bounced, unsubscribed, and
opportunities with their value. Rates count each lead once. The bounce rate is hard bounces out of every email tried
(sent, plus refused when sending). Campaign totals include subsequence emails; the step-by-step table doesn't.

## 3. Mailboxes and deliverability

### Connecting

- **Any IMAP/SMTP mailbox:** the address and password (often an app password). Reachstack knows the servers for Gmail,
  Outlook, Yahoo, iCloud, Zoho, Fastmail, Yandex, GoDaddy and Amazon WorkMail, and works out others from the domain's
  mail servers. It signs in to both SMTP and IMAP before it saves anything, and explains what to fix when that fails.
- **Google and Microsoft by signing in:** no password is shared; Reachstack gets a token for that mailbox. The owner
  sets this up once in Settings → Installation → Services with an OAuth app from Google Cloud or Microsoft Entra. The
  redirect addresses to register are `<your address>/api/app/oauth/google/callback` and
  `<your address>/api/app/oauth/microsoft/callback`. A Google app still in "Testing" signs people out after 7 days.
- **Test mailboxes** live in the database and never send real email.

Passwords and tokens are encrypted (AES-256-GCM) with a key from `APP_SECRET`, or else from `data/secret.key`, and are
only decrypted in memory to use them. A mailbox's password only ever goes to the server it was entered for.

Each mailbox has a sender name (the "From" name), an optional reply-to address, a signature, a daily limit, a gap
between emails, slow ramp-up, tags, and **Rest** (3 to 30 days without campaign emails while warmup carries on).

### Warmup

Warmup sends emails between your own mailboxes and answers them, so mail providers see a new mailbox having normal
conversations before it sends campaigns.

- **Partners:** every real mailbox with warmup on, in every workspace of this installation, is in one pool (test
  mailboxes warm up only with each other). Partners are picked at random, preferring other domains. **It needs at
  least two mailboxes**, ideally on different domains; with one, the mailbox page says there's no one to warm up with.
- **Amounts:** 10 emails a day by default, starting at 2 and adding 1 a day; 30% get a reply. Emails go out between
  06:00 and 22:00 on the workspace's clock, and replies 10–90 minutes later.
- **Rescue:** the receiving mailbox opens each warmup email, marks it important, and moves it out of spam if it landed
  there.
- **Out of sight:** warmup emails are recognised by their message id, so they never show in the Unibox or in campaign
  analytics. Each also carries a tag (in the subject and the last line) so people can filter them in their own mail
  app.
- **Scores:** every 15 minutes each mailbox gets a warmup score: the share of its warmup emails from the last 7 days
  that reached the inbox.

Let warmup run for about two weeks before a mailbox sends campaigns; the launch check warns about younger ones.
Warmup inside one installation is a small pool: it helps, but it's no substitute for sending slowly and to people
who want to hear from you.

### Health

Each mailbox's health starts at 100 and loses points for what went wrong in the last 14 days: hard bounces, sending
errors, warmup emails landing in spam, and no replies after 50 sends. 90 and up is healthy, 70 and up fair, below that
at risk. Email accounts shows each mailbox's health.

### DNS and blocklists

For each sending domain, Reachstack checks the MX records, that there's exactly one SPF record and one DMARC record,
and DKIM (by trying 20 common selectors). It looks the domain up on 4 domain blocklists, and the domain's address on
10 IP blocklists. These checks run when a mailbox connects, when you ask, and again every day. They inform; they
never stop a launch.

### Inbox placement tests

A placement test sends an email to *seed* mailboxes and looks where it landed: inbox or spam. The seeds are mailboxes
of this installation that an administrator marks as seeds (with test mailboxes, 9 simulated seeds). An email found in
a spam folder, or not found within 30 minutes, counts as spam. The report also shows SPF, DKIM and DMARC results and
the sending IP. Tests can run on a schedule and set off automations (pause mailboxes or campaigns, send a webhook…).

**Spam score:** with `SPAMD_HOST` set, emails are scored by SpamAssassin; otherwise by built-in rules.

## 4. Replies and the Unibox

The Unibox is every reply from every mailbox in one place.

- **Folders and filters:** Inbox, Sent, Scheduled, Reminders and Done; Primary and Others (automatic replies and
  people who aren't leads); each interest label with its count; filters by campaign, mailbox and unread.
- **Search** understands `from:`, `to:`, `lead:`, `subject:`, `campaign:`, `has:attachment`, `is:unread`,
  `before:` and `after:`, among others.
- **Writing:** reply, reply all and forward, with cc, bcc and attachments (25 MB). Saved replies fill in the lead's
  details; the AI can draft a reply (it never sends one by itself here).
- **Send later** at a time you pick; the email is checked again (paused mailbox, unsubscribed person) before it goes.
- **Reminders** bring a conversation back to the Inbox, unread, when they come due, unless the lead replied first.
- **Shortcuts:** `e` marks a conversation done, `1`–`9` set labels.
- **Export** a conversation as .eml, .mbox or CSV.

What you do in the Unibox stays in Reachstack: reading, deleting or labelling a conversation doesn't change the
mailbox itself, and replies appear in the provider's Sent folder only when the provider files them there (Gmail
does).

## 5. Leads, lists and the CRM

**Getting leads in:** import a CSV (you match its columns to lead fields; other columns become your own fields, usable
as `{{variables}}`), paste addresses, add people one at a time, send them from Lead Finder, or add them through the
API and the AI tools. Leads live in a campaign or in a lead list, and can move from a list into a campaign. An import
can leave out people already in the workspace or in another campaign, and can verify addresses first.

**Blocklist:** addresses and whole domains that are never emailed, from any campaign. People who unsubscribe are
added by default. A blocklist can also follow a Google Sheet (one column of addresses or domains, shared as "anyone
with the link can view"), read again every day.

**Email verification** checks the syntax, the domain's mail servers, throwaway-address domains and role addresses
(info@, sales@…). With `VERIFY_SMTP_PROBE=true` it also asks the receiving server whether the mailbox exists and spots
catch-all domains; that needs outgoing port 25, which most home connections and cloud hosts block. No outside service
is used, and results are kept for 30 days.

**CRM:** a lead who replies positively becomes an opportunity, whose stage follows their interest label, with a
value you can set (a default per workspace or per campaign). It has tasks, notes, meetings and reports, and a team
inbox for emails, calls, texts and tasks. With Twilio (one account for the installation), "call" rings your own phone
and then connects you to the lead; you can also send and receive text messages and buy or bring phone numbers.

**Today** estimates what goes out today and this week, says what holds it back (the schedule, a daily limit, the
gaps, no leads due), and lists the tasks due from task steps in sequences (a call, a LinkedIn message…).

**Website visitors:** a small script on your website (`/wv.js`) reports visits, and an IP lookup (ipinfo.io, with your
token) names the companies behind them. It only ever identifies companies, never people, sets no cookies, and
respects "do not track". Views can add the companies' people to a list or send alerts.

## 6. Lead Finder

Lead Finder searches people and companies, enriches them and sends them to a list or a campaign.

- **The data is yours.** Reachstack doesn't come with a database of people. An administrator imports a CSV for the
  whole installation, or a workspace imports its own. To try it, **Lead Finder → Data source → Load demo data** (or
  `npm run seed:demo`) adds 1,500 made-up companies and their people.
- **Search** by job title, level, department, location, company size, revenue, industry, keywords and technologies,
  or describe who you want in a sentence and let the AI set the filters.
- **Enrichment** finds work emails (address patterns checked with the mail server, and Hunter with
  `HUNTER_API_KEY`), and adds company details from their websites, news, job listings (Greenhouse, Lever, Ashby) and
  AI-written columns.
- **The Lead Finder agent** keeps a campaign stocked: when fewer leads are waiting than you chose, it adds more.
- **Credits:** in unlimited workspaces (the owner's, and others by default) nothing is counted. In a workspace on a
  plan, revealing an email, enriching and verifying use credits.
- **The privacy center** (`/privacy`) lets people in your data opt out, ask what you hold about them, or report an
  email. Opt-outs act at once; administrators see the rest in Settings → Privacy center.

## 7. AI

Reachstack works without AI. With it, it writes and reads for you. Choose the AI in **Settings → Installation →
Services** (or `.env`):

- **Claude:** an API key from console.anthropic.com. The default model is `claude-opus-5-5`; `ANTHROPIC_MODEL` picks
  another.
- **An AI on your own computer** that speaks the OpenAI API, such as Ollama (`http://localhost:11434/v1`) or LM Studio
  (`http://localhost:1234/v1`), with its model name. Bigger models write better; Copilot needs one that supports tool
  calls, and reading PDFs into Copilot's memory still needs Claude.

A workspace can also use its own Claude key (Settings → Integrations & API → AI), which then takes precedence.

What uses the AI:

- **Writing help** in the sequence editor: write or rewrite an email, write a whole sequence from a short brief,
  spintax, spam-word checks, and a diagnosis of a campaign that isn't working.
- **Replies:** draft a reply in the Unibox, and label replies by interest.
- **AI agents:** the reply agent answers leads (it shows you its drafts first, or sends on autopilot), with
  follow-ups and win-backs for no-shows; the sales agent runs outreach in copilot or autopilot mode; the Lead Finder
  agent stocks campaigns; the deliverability agent watches the mailboxes.
- **Copilot,** an assistant inside the app: it answers questions about your workspace and does things for you with 19
  tools. Anything that changes data waits for your approval unless you turn on "warp mode". It remembers your business
  details and can run recurring tasks.
- **Lead Finder:** search from a sentence, and AI columns that write a line per lead.
- **Automations:** "Ask AI" builds an automation from a description.

These are different from the **AI assistants outside the app** (Claude Code, Claude Desktop, Cursor, Codex…) that
use Reachstack through its MCP server; for those, see [agents.md](agents.md).

## 8. Automations, webhooks and the API

**Automations** run steps when something happens, built in a visual editor: 22 triggers (a reply arrives, a label
changes, an email bounces, a webhook comes in, a schedule, the Run button…) and 16 actions, plus conditions, delays
(up to 30 days), paths that split and join, and up to 100 steps. History shows every step's input and output, a retry
continues from the step that failed, and automations that would set each other off in a loop are stopped.

**Webhooks** send events to your own address as they happen. The events: every email sent, opened, clicked, replied
to, auto-replied to, bounced; unsubscribes; each interest label (interested, meeting booked, not interested…);
campaign completed; mailbox errors; enrichment finished; or all of them. With a secret, each delivery is signed: the
header `x-webhook-signature` holds `sha256=` and the HMAC-SHA256 of the body. Failed deliveries are retried after 1
minute, 5 minutes, 30 minutes, 2 hours and 6 hours, and a webhook is switched off after 25 failures in a row. The
delivery log keeps 30 days.

**The REST API** (`/api/v2/…`) does everything the app does, with API keys made in Settings → Integrations & API. A
key works in one workspace, with full access, read-only access or the scopes you choose (`campaigns:read`,
`leads:update`…). Every installation has the full reference at `/developers`. Its numeric codes follow the public
v2 API's enums, so existing API clients keep working.

**The MCP server** (`/mcp`) gives AI assistants 35 tools over the same API: see [agents.md](agents.md).

## 9. People, workspaces and agencies

- **The owner** is the first account. The owner's workspaces are never limited or charged, and only the owner changes
  installation settings. The owner can make others **administrators**, who look after people and shared data such
  as the Lead Finder data, but can't change settings. `npm run owner -- someone@example.com` hands ownership over.
- **Workspaces** have members with a role: owner, admin, editor, view or client. Roles come with permissions (13 of
  them: campaigns, Unibox, analytics, mailboxes, leads, CRM, Lead Finder, blocklist, settings, billing, team…), which
  can be changed per member. Invite people in Settings → Workspace & members.
- **Sign-up** is by invitation unless the owner opens it (Settings → Installation → Access & features), or closes it
  altogether.
- **Other people's workspaces** are unlimited by default. With Stripe set up, new ones start on a 14-day trial with
  small limits and then need a plan; the owner can assign plans, set trial ends and grant credits in Settings →
  Installation → Workspaces.
- **Agencies:** Settings → Agency & white label sets an agency name, a brand colour, the workspace's logo and what
  clients see (dashboard, campaigns, analytics, Unibox). Clients are invited with the client role and sign in at
  `/client/login`. A client portal can have its own domain: point a CNAME at your Reachstack's address and set it up
  there (HTTPS for that domain is your web server's job, see [self-hosting.md](self-hosting.md)). Workspace groups
  link client workspaces together.

## 10. Safety nets

- **Unsubscribes, bounces and the blocklist** hold across the workspace, and even after a lead is deleted: someone
  who unsubscribed or bounced isn't emailed again when they're added back.
- **Bounce protection, the send watchdog and the launch check** (section 2) stop the most common ways a campaign goes
  wrong.
- **Recently deleted** (Settings) keeps deleted campaigns, lists and more for 30 days.
- **Backups** (Settings → Installation → Backups) are complete: the database, the encryption key and the files. They
  run daily or weekly (off until you turn them on), keep the last 7 by default, and can be made by hand. A restore
  checks the file first (its checksum, the database's integrity and tables, free space, and that it isn't from a newer
  version), happens at the next start, keeps what it replaced in `data/backups/before-restore-…`, and pauses the
  campaigns so nothing sends before you've looked. Copy backups somewhere else too.
- **Audit logs** (Settings) record sign-ins, API keys, changes to members and other sensitive actions.
- **Two-step sign-in** with an authenticator app, in Settings → Profile & security.

## 11. Make it yours

### In the app

- **Settings → Installation** (the owner): **Access & features** for sign-up, what new workspaces get, and which
  parts are switched on: Copilot, AI agents, automations, Lead Finder, verification, CRM, website visitors, inbox
  placement, templates, agency and done-for-you. Switching a part off removes it from the menus and pages; its API
  stays available to keys. **Services** for the AI, system email, Google and Microsoft sign-in, email checks, IP
  lookup, Twilio, and the product's name and privacy contacts. **Backups**, **Workspaces** and **People**.
- **Settings → Preferences** (a workspace's admins): its name, logo and time zone; whether a reply stops the person
  in every campaign; automatic reply labels; what the Unibox shows; bounce protection; how mailboxes take turns; and
  notifications.
- **Settings → Advanced deliverability:** rules on top of every campaign: no open tracking anywhere, matching the
  lead's email provider, a plain-text first email, a limit of emails per company, and which leads to leave out.
- **Settings → Custom warmup copy, Lead labels, Custom variables, Custom tags** for a workspace's own wording, labels
  and fields.

### In `.env`

Copy [`.env.example`](../.env.example) to `.env`; it explains every setting. The main groups:

| Settings | What for |
|---|---|
| `BRAND_NAME` | The product's name everywhere: the app, page titles, emails, the unsubscribe page, Copilot and the MCP server |
| `APP_URL`, `PORT`, `HOST`, `WEB_URL`, `TRACKING_BASE_URL` | Where it runs, and the address in links and tracking |
| `DATA_DIR`, `APP_SECRET` | Where data is kept, and the encryption key (otherwise `data/secret.key`) |
| `SYSTEM_SMTP_*` | The mailbox that sends invitations, password resets and notifications |
| `GOOGLE_CLIENT_*`, `MICROSOFT_CLIENT_*` | Sign-in with Google and Microsoft, for mailboxes and accounts |
| `ANTHROPIC_*`, or `AI_PROVIDER=openai` with `OPENAI_*` | The AI |
| `STRIPE_*` | Plans and payments for other people's workspaces (only in `.env`) |
| `TWILIO_*`, `IPINFO_TOKEN`, `HUNTER_API_KEY` | Calls and texts, website visitors, email finding |
| `VERIFY_SMTP_PROBE`, `SPAMD_HOST`, `DNS_FALLBACK_SERVERS` | Deeper email checks |
| `TRUST_PROXY`, `ALLOW_PRIVATE_URLS`, `RUN_WORKER_IN_PROCESS`, `REACHSTACK_SUPERVISOR`, `LOG_LEVEL` | Running on a server |
| `PRIVACY_EMAIL`, `PRIVACY_PHONE`, `PRIVACY_POLICY_URL`, `TERMS_URL` | The privacy center and the sign-up page |

Values saved in Settings → Installation → Services take precedence over `.env`, apply within 30 seconds, and secrets
are stored encrypted. Changes to `.env` apply when Reachstack starts again.

### The look

The web app's colours are CSS variables in [`apps/web/src/index.css`](../apps/web/src/index.css): one block for light
mode (`:root`) and one for dark (`.dark`). The main ones are `--bg`, `--panel`, `--line`, `--text`, `--muted` and the
brand colour, `--brand` with `--brand-hover`, `--brand-soft`, `--brand-text` and `--ring`; Tailwind classes such as
`bg-brand` and `text-muted` come from them. To use your own brand colour, change those five in both blocks. The
launcher rebuilds the web app when it starts after a change (or run `npm run build`). A few places keep their own
copy of the colour: `apps/web/public/favicon.svg`, system emails (`apps/server/src/services/system-mail.ts`) and the
sign-in pages' side panel (`apps/web/src/pages/auth/AuthLayout.tsx`).

The font is Inter when the computer has it, else the system's own. The logo in the corner is the name's first
letter on the brand colour; a workspace's own logo (Settings → Preferences) shows to its members and clients.

## 12. Changing the code

Reachstack is TypeScript from end to end. [CONTRIBUTING.md](../CONTRIBUTING.md) covers running it from source
(`npm run dev`), the checks (`npm run typecheck`, `npm test`, `npm run build`) and the conventions, and
[architecture.md](architecture.md) maps the folders. An AI coding assistant opened in the folder reads
[AGENTS.md](../AGENTS.md), so you can describe a change and let it work. Common changes:

**An API endpoint.** Routes are Fastify plugins in `apps/server/src/routes/`, registered in `routes/index.ts`. Each
route says who may use it in `config`, and validates its input with zod:

```ts
app.post("/api/v2/campaigns", { config: { scope: ["campaigns", "create"], perm: "edit_campaigns", write: true } }, async (req) => {
  const c = ctx(req); // the workspace (c.wsId) and who is asking
  const b = body(req, z.object({ name: z.string().min(1) }));
  // …
});
```

`perm` is the permission needed, `write` means editors and up, `admin` admins and the owner. A route without `scope`
can't be used with an API key. A new `/api/v2` endpoint also gets a line in `apps/server/src/http/api-reference.ts`
for `/developers` (`npm run routes:audit -w @reachstack/server` lists missing ones).

**A page.** Add a route in `apps/web/src/router.tsx`, for example
`r("today", page(() => import("@/pages/app/today/Today")))`. Pages read data with TanStack Query and `get()` from
`@/lib/api`, check permissions with `useCan()`, and set their title with `usePageTitle`. The sidebar is `NAV` in
`apps/web/src/components/shell/nav.ts`; settings pages are listed in `SettingsLayout.tsx`.

**A database column.** Edit the table in `apps/server/src/db/schema/`, then generate a migration:
`cd apps/server && npx drizzle-kit generate --name what_changed`. It runs when the server starts. A workspace setting
can go in the workspace's `settings` JSON instead, with no migration.

**Background work.** A loop in `apps/server/src/engine/register.ts`, such as
`registerLoop("reminders", 30_000, () => runReminders())`, runs only in the process that holds the engine. One-off
long work is a job: `registerJobHandler()` and `createJob()` in `services/jobs.ts`.

**A permission.** Add it to `PERMISSIONS` (and `ROLE_DEFAULTS`) in `packages/shared/src/permissions.ts`, give it a
label in the members pages, and use it as `perm: "x"` on routes and `useCan().perm("x")` in the app.

**An AI assistant tool.** Tools are in `apps/server/src/services/mcp-tools.ts`. Each has a name, a description the AI
reads, a zod input and a `run` that calls the REST API with the assistant's key:

```ts
tool({
  name: "list_tags",
  title: "List tags",
  description: "The workspace's tags, to filter campaigns and mailboxes.",
  input: z.object({ search: z.string().optional() }),
  annotations: READ,
  async run(a, ctx) {
    return call(ctx, "GET", "/api/v2/custom-tags", { query: { search: a.search } });
  },
}),
```

Add the tool to the tables in [agents.md](agents.md) (a test checks that every tool is there) and a test in
`apps/server/test/mcp.test.ts`. Tests give each file an empty database and block the network, so use test mailboxes
and `.test` addresses.

## 13. Limits, and what has been tested

- **Tests:** about 870 automated tests, each file on an empty database with the network blocked, run on Linux with
  Node 22 and 24 for every change. A first-start check installs and starts a fresh copy on Linux, macOS and Windows,
  makes the owner, launches a campaign with test mailboxes and uses the AI tools.
- **Not yet tried against the real services.** Everything was built and tested with test mailboxes and local
  stand-ins, so treat these as new: sending and inbox sync with real Gmail, Outlook and other IMAP/SMTP mailboxes,
  warmup's "mark important" and "rescue from spam" on real mail servers, Google and Microsoft sign-in, Stripe, Twilio,
  the IP lookup, the AI features with a real AI, and DNS checks of real domains. Start with one or two mailboxes and
  low limits, watch the first days, and report what you find in the repository's issues.
- **One server, one database file.** SQLite holds up well for a team and many mailboxes on one machine, but
  Reachstack isn't built to spread over several servers.
- **Warmup is as big as your installation:** your own mailboxes only, not a network of other people's.
- **Opens and clicks** are only counted on a server the internet can reach (section 1).
- **The Unibox doesn't change the mailboxes** themselves (section 4).
- **Windows on ARM** needs the x64 version of Node.js.
