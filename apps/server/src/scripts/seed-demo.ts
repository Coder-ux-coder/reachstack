// Fills this installation with made-up demo data, from the machine the app runs on: the Lead Finder demo dataset
// (what Lead Finder → Data source → Load demo data does) and, in a workspace you name, sandbox mailboxes.
//
//   npm run seed:demo                                      1,500 companies with their people, news and job posts
//   npm run seed:demo -- --companies 300                   another number of companies (10 to 20,000)
//   npm run seed:demo -- --workspace "Acme Outreach"       also 3 sandbox mailboxes there (--mailboxes 5 for more)
//   npm run seed:demo -- --remove                          takes the demo companies and people out again
//
// Everything is fictional: reserved .test domains, 555-01xx phone numbers, no social profiles. Sandbox mailboxes send
// and receive inside the database only. Loading again replaces the earlier demo companies.
import { parseArgs } from "node:util";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, initDb, schema } from "../db/client";
import { createSandboxAccounts } from "../services/account-connect";
import { deleteDemoDataset, loadDemoDataset } from "../services/lead-finder/dataset";

const { values } = parseArgs({
  options: {
    companies: { type: "string" },
    workspace: { type: "string" },
    mailboxes: { type: "string" },
    remove: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (values.help) {
  console.log("npm run seed:demo [-- --companies 1500] [--workspace <name or id> [--mailboxes 3]] | [-- --remove]");
  process.exit(0);
}

const companies = values.companies === undefined ? 1_500 : Number(values.companies);
if (!Number.isInteger(companies) || companies < 10 || companies > 20_000) fail("--companies takes a whole number from 10 to 20,000.");
const mailboxes = values.mailboxes === undefined ? 3 : Number(values.mailboxes);
if (!Number.isInteger(mailboxes) || mailboxes < 1 || mailboxes > 25) fail("--mailboxes takes a whole number from 1 to 25.");
if (values.mailboxes !== undefined && !values.workspace) fail("Name the workspace for the mailboxes with --workspace.");

await initDb();

if (values.remove) {
  const gone = await deleteDemoDataset();
  console.log(`Removed ${gone.companies.toLocaleString("en-US")} demo companies and ${gone.people.toLocaleString("en-US")} people.`);
  process.exit(0);
}

// The workspace first, so a wrong name fails before the slow part.
let workspace: { id: string; name: string } | null = null;
if (values.workspace) {
  const wanted = values.workspace.trim();
  const W = schema.workspaces;
  const found = await db
    .select({ id: W.id, name: W.name })
    .from(W)
    .where(and(isNull(W.deletedAt), or(eq(W.id, wanted), sql`lower(${W.name}) = lower(${wanted})`)));
  if (!found.length) fail(`No workspace is called or has the id "${wanted}".`);
  if (found.length > 1) fail(`Several workspaces are called "${wanted}". Use one of their ids: ${found.map((w) => w.id).join(", ")}.`);
  workspace = found[0]!;
}

// Progress on one line in a terminal; nothing until the end otherwise.
const tty = process.stdout.isTTY;
let last = -1;
const demo = await loadDemoDataset({ companies }, async (pct) => {
  const step = Math.floor(pct / 10) * 10;
  if (tty && step > last) {
    last = step;
    process.stdout.write(`\rLoading demo companies… ${step}%`);
  }
});
if (tty) process.stdout.write("\r\x1b[K");
console.log(`Loaded ${demo.companies.toLocaleString("en-US")} demo companies with ${demo.people.toLocaleString("en-US")} people (Lead Finder).`);

if (workspace) {
  const accounts = await createSandboxAccounts(workspace, null, { count: mailboxes, enableWarmup: false });
  console.log(`Added ${accounts.length} sandbox mailbox${accounts.length === 1 ? "" : "es"} to ${workspace.name}: ${accounts.map((a) => a.email).join(", ")}.`);
}
process.exit(0);
