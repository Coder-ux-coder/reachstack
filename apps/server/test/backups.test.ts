// Backups, restore and "Download all data" (services/backup-archive.ts, backup-restore.ts, backups.ts,
// workspace-export.ts, routes/backups.ts): what a backup holds, that only the installation owner can touch backups,
// how a restore checks its file and is swapped in at the next start, and that a workspace export holds that
// workspace's data, nothing from other workspaces, and no secrets. Every value here is a made-up test string.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { FastifyInstance } from "fastify";
import { CampaignStatus, EmailType } from "@reachstack/shared";
import { TEST_DATA_DIR } from "./helpers/setup";
import { PASSWORD, TestClient, expectStatus, json, listRoutes, signUp, startServer, stopServer, uniqueEmail, type Res, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { runPendingJobs } from "../src/engine/jobs";
import { config } from "../src/env";
import { encrypt } from "../src/lib/crypto";
import { libsqlModulePath, readTarGz, safeEntryPath, writeTarGz, type TarSource } from "../src/services/backup-archive";
import { applyPendingRestore, dataDirFromEnv, fileStamp, readLastRestore, readPendingRestore, removeRestoreLeftovers, stageRestore } from "../src/services/backup-restore";
import { automaticBackupDue, lastSlot, listBackups, nextSlot, pauseSendingAfterRestore, runScheduledBackup } from "../src/services/backups";
import { setAppSetting } from "../src/services/instance";
import { removeOldExports, workspaceExportFile } from "../src/services/workspace-export";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(here, "..");
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "rs-backups-"));
const IMAP_PASSWORD = "imap-pass-for-backup-tests-1";
const SMTP_PASSWORD = "smtp-pass-for-backup-tests-2";
const OAUTH_TOKEN = "oauth-access-token-for-backup-tests-3";
const AI_KEY = "sk-ant-not-a-real-key-for-backup-tests-4";
const SECRET_FILE = "secret-file-for-backup-tests-not-a-real-key";
const LONG_NAME = `${"ü".repeat(30)}-${"a-long-attachment-name-".repeat(5)}.txt`;

let app: FastifyInstance;
let owner: TestUser;
let admin: TestUser;
let alice: TestUser;
let bob: TestUser;
/** The first backup made in this file, downloaded. */
let backup: { id: string; data: Buffer; file: string };

before(async () => {
  app = await startServer();
  owner = await signUp(app, { firstName: "Owner" });
  admin = await signUp(app, { firstName: "Admin" });
  alice = await signUp(app, { firstName: "Alice", workspaceName: "Alice Co" });
  bob = await signUp(app, { firstName: "Bob", workspaceName: "Bob Co" });
  expectStatus(await owner.client.patch(`/api/app/admin/users/${admin.id}`, { admin: true }), 200);

  // A secret.key file and some files in the folders a backup carries. (These tests take their key from APP_SECRET.)
  writeFileSync(path.join(TEST_DATA_DIR, "secret.key"), SECRET_FILE);
  mkdirSync(path.join(TEST_DATA_DIR, "attachments", "ws1", "email1"), { recursive: true });
  writeFileSync(path.join(TEST_DATA_DIR, "attachments", "ws1", "email1", "quote.pdf"), "pretend pdf");
  writeFileSync(path.join(TEST_DATA_DIR, "attachments", "ws1", "email1", LONG_NAME), "a file with a long name");
  writeFileSync(path.join(TEST_DATA_DIR, "uploads", "import.csv"), "email\nsomeone@example.test\n");
});
after(async () => {
  await stopServer();
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ---------- Helpers ----------

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Every file in a .tar.gz, read without the app's own reader (ustar names, pax "path" records). */
function untar(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz);
  const out = new Map<string, Buffer>();
  let pos = 0;
  let paxPath: string | null = null;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a: number, b: number) => {
      const s = h.subarray(a, b);
      const end = s.indexOf(0);
      return s.toString("utf8", 0, end === -1 ? s.length : end);
    };
    const size = parseInt(field(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156]!);
    const prefix = h.toString("ascii", 257, 262) === "ustar" ? field(345, 500) : "";
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const data = Buffer.from(tar.subarray(pos + 512, pos + 512 + size));
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? null;
      continue;
    }
    out.set(paxPath ?? name, data);
    paxPath = null;
  }
  return out;
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const overview = async (u: TestUser = owner) => json(await u.client.get("/api/app/admin/backups"));

async function makeBackup(): Promise<string> {
  const before = new Set((await overview()).backups.map((b: { id: string }) => b.id));
  expectStatus(await owner.client.post("/api/app/admin/backups"), 202);
  await waitFor(async () => (await overview()).running === null, "the backup");
  const o = await overview();
  assert.equal(o.last.ok, true, `last backup failed: ${o.last.error}`);
  const made = o.backups.find((b: { id: string }) => !before.has(b.id));
  assert.ok(made, "a new backup is listed");
  return made.id as string;
}

/** A multipart body: fields first (the password), then the file. */
function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }) {
  const boundary = `----rs-test-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/gzip\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

function upload(client: TestClient, data: Buffer, password = PASSWORD): Promise<Res> {
  const m = multipart({ password }, { name: "backup.tar.gz", data });
  return client.request("POST", "/api/app/admin/backups/restore", m.body, { headers: { "content-type": m.type } });
}

async function archive(entries: TarSource[]): Promise<Buffer> {
  const file = path.join(SCRATCH, `${randomUUID()}.tar.gz`);
  await writeTarGz(file, entries);
  return readFileSync(file);
}

const SQLITE_SOURCE = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2]);
const out = [];
for (const [sql, ...params] of JSON.parse(process.argv[3])) {
  const st = db.prepare(sql);
  if (/^\\s*select/i.test(sql)) out.push(st.all(...params));
  else { st.run(...params); out.push([]); }
}
db.close();
process.stdout.write(JSON.stringify(out));
`;

/**
 * Runs SQL on a database file in a separate node process, one result list per statement. The driver keeps a file open
 * after close() and Windows can't move an open file, so this test process never opens one itself.
 */
function sqlite(file: string, ...statements: Array<[sql: string, ...params: unknown[]]>): Array<Array<Record<string, unknown>>> {
  const run = spawnSync(process.execPath, ["-e", SQLITE_SOURCE, libsqlModulePath(), file, JSON.stringify(statements)], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

// ---------- Making backups ----------

describe("a backup", () => {
  it("holds a consistent copy of the database, the secret key, the folders and a manifest, in that order", async () => {
    const id = await makeBackup();
    assert.match(id, /^backup-\d{4}-\d{2}-\d{2}-\d{6}-manual\.tar\.gz$/);
    assert.deepEqual(readdirSync(path.join(TEST_DATA_DIR, "backups")).filter((n) => n.startsWith(".")), [], "no work files are left behind");
    const res = await owner.client.get(`/api/app/admin/backups/${id}/download`);
    expectStatus(res, 200);
    assert.equal(res.headers["content-type"], "application/gzip");
    assert.match(String(res.headers["content-disposition"]), /attachment; filename="reachstack-backup-.+\.tar\.gz"/);
    assert.equal(res.headers["cache-control"], "no-store");
    const data = res.rawPayload;
    const file = path.join(SCRATCH, id);
    writeFileSync(file, data);
    backup = { id, data, file };

    const files = untar(data);
    assert.equal([...files.keys()][0], "manifest.json");
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    assert.equal(manifest.format, "reachstack-backup");
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.kind, "manual");
    assert.equal(manifest.app.name, "Reachstack");
    assert.ok(Date.parse(manifest.created_at) <= Date.now());

    const dbCopy = files.get("app.db")!;
    assert.equal(dbCopy.subarray(0, 16).toString("latin1"), "SQLite format 3\0");
    assert.equal(dbCopy.length, manifest.database.bytes);
    assert.equal(sha256(dbCopy), manifest.database.sha256);
    assert.equal(manifest.database.counts.users, 4);
    assert.ok(manifest.database.migration_at > 0);

    // The copy opens on its own and holds the accounts.
    const copy = path.join(SCRATCH, `${randomUUID()}.db`);
    writeFileSync(copy, dbCopy);
    assert.equal(Number(sqlite(copy, ["select count(*) as n from users"])[0]![0]!.n), 4);

    assert.equal(files.get("secret.key")?.toString("utf8"), SECRET_FILE);
    assert.equal(manifest.secret_key.included, true);
    assert.equal(manifest.secret_key.source, "environment");
    assert.equal(files.get("attachments/ws1/email1/quote.pdf")?.toString(), "pretend pdf");
    assert.equal(files.get(`attachments/ws1/email1/${LONG_NAME}`)?.toString(), "a file with a long name");
    assert.equal(files.get("uploads/import.csv")?.toString(), "email\nsomeone@example.test\n");
    assert.deepEqual(manifest.folders.attachments, { files: 2, bytes: "pretend pdf".length + "a file with a long name".length });
    assert.equal(manifest.folders.uploads.files, 1);
  });

  it("reads back with the app's reader, and with the system's tar when there is one", async () => {
    const names: string[] = [];
    for await (const entry of readTarGz(backup.file)) names.push(entry.name);
    assert.ok(names.includes(`attachments/ws1/email1/${LONG_NAME}`));
    const tar = spawnSync("tar", ["-tzf", path.basename(backup.file)], { cwd: SCRATCH, encoding: "utf8" });
    if (tar.error || tar.status !== 0) return; // no tar here (or one that can't read gzip): the check above stands
    const listed = tar.stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(listed.includes("manifest.json") && listed.includes("app.db"), tar.stdout);
    assert.ok(listed.some((l) => l.endsWith("a-long-attachment-name-.txt")), "the long name survives in a standard tar");
  });

  it("reads back however many files have long names: the headers carrying them aren't counted as files", async () => {
    const long = (i: number) => `uploads/${"a-long-file-name-".repeat(8)}${i}.txt`;
    const file = path.join(SCRATCH, `${randomUUID()}.tar.gz`);
    await writeTarGz(file, [1, 2, 3].map((i) => ({ name: long(i), data: Buffer.from(String(i)) })));
    const names: string[] = [];
    for await (const entry of readTarGz(file, { maxEntries: 3 })) names.push(entry.name);
    assert.deepEqual(names, [long(1), long(2), long(3)]);
    await assert.rejects(async () => {
      for await (const entry of readTarGz(file, { maxEntries: 2 })) void entry;
    }, /too many files/);
  });

  it("a run of name headers with no file after them is damage, not something to read through", async () => {
    const file = path.join(SCRATCH, `${randomUUID()}.tar.gz`);
    await writeTarGz(file, [{ name: `uploads/${"x".repeat(150)}.txt`, data: Buffer.from("x") }]);
    const tar = gunzipSync(readFileSync(file));
    // The pax header and its one-block record come first; repeat them a dozen times.
    const bad = path.join(SCRATCH, `${randomUUID()}.tar.gz`);
    writeFileSync(bad, gzipSync(Buffer.concat([...Array.from({ length: 12 }, () => tar.subarray(0, 1024)), tar.subarray(1024)])));
    await assert.rejects(async () => {
      for await (const entry of readTarGz(bad)) void entry;
    }, /damaged/);
  });

  it("is listed, can be deleted, and a second one at once gets a 409", async () => {
    const o = await overview();
    assert.ok(o.backups.some((b: { id: string; kind: string; bytes: number }) => b.id === backup.id && b.kind === "manual" && b.bytes === backup.data.length));
    assert.equal(o.storage.backups_dir, path.join(TEST_DATA_DIR, "backups"));
    assert.equal(o.secret_key.source, "environment");

    expectStatus(await owner.client.post("/api/app/admin/backups"), 202);
    const second = await owner.client.post("/api/app/admin/backups");
    expectStatus(second, 409);
    await waitFor(async () => (await overview()).running === null, "the backup");
    const extra = (await overview()).backups.find((b: { id: string }) => b.id !== backup.id);
    expectStatus(await owner.client.delete(`/api/app/admin/backups/${extra.id}`), 200);
    expectStatus(await owner.client.delete(`/api/app/admin/backups/${extra.id}`), 404);
    assert.ok(!(await overview()).backups.some((b: { id: string }) => b.id === extra.id));
  });

  it("never serves anything but a backup file", async () => {
    for (const bad of ["..%2F..%2Fapp.db", "app.db", "secret.key", ".lock", "backup-2026-01-01-000000-manual.tar.gz"]) {
      expectStatus(await owner.client.get(`/api/app/admin/backups/${bad}/download`), 404, bad);
    }
  });
});

describe("who can touch backups", () => {
  it("only the installation owner: administrators and everyone else get a 403 on every backup route", async () => {
    const routes = (await listRoutes()).filter((r) => r.url.startsWith("/api/app/admin/backups"));
    assert.ok(routes.length >= 8, `only found ${routes.length} backup routes`);
    const failures: string[] = [];
    for (const who of [admin, alice]) {
      for (const r of routes) {
        const url = r.url.replace(":id", backup.id);
        const res = await who.client.request(r.method as "GET", url, r.method === "GET" || r.method === "DELETE" ? undefined : { password: who.password });
        if (res.statusCode !== 403) failures.push(`${who.me.user.first_name}: ${r.method} ${r.url} → ${res.statusCode}`);
      }
      expectStatus(await upload(who.client, backup.data, who.password), 403);
    }
    assert.deepEqual(failures, []);
    assert.equal((await overview()).pending_restore, null);
    assert.ok((await overview()).backups.some((b: { id: string }) => b.id === backup.id));
  });
});

// ---------- Restoring ----------

describe("restoring", () => {
  it("asks for the owner's password", async () => {
    const res = await upload(owner.client, backup.data, "wrong-password");
    expectStatus(res, 400);
    assert.equal(res.json().message, "Incorrect password");
    expectStatus(await owner.client.post(`/api/app/admin/backups/${backup.id}/restore`, { password: "wrong-password" }), 400);
    expectStatus(await owner.client.post(`/api/app/admin/backups/${backup.id}/restore`, {}), 400);
    assert.equal((await overview()).pending_restore, null);
  });

  it("rejects files that aren't sound backups of this app, saying why", async () => {
    const manifest = JSON.parse(untar(backup.data).get("manifest.json")!.toString("utf8"));
    const dbCopy = untar(backup.data).get("app.db")!;
    const withDb = (db: Buffer, change: (m: Record<string, any>) => void = () => undefined) => {
      const m = structuredClone(manifest);
      m.database.bytes = db.length;
      m.database.sha256 = sha256(db);
      m.secret_key.included = false;
      change(m);
      return archive([
        { name: "manifest.json", data: Buffer.from(JSON.stringify(m)) },
        { name: "app.db", data: db },
      ]);
    };
    // A database from a newer version of the app: its newest migration is later than any this version knows.
    const newer = path.join(SCRATCH, `${randomUUID()}.db`);
    writeFileSync(newer, dbCopy);
    sqlite(newer, ["update __drizzle_migrations set created_at = created_at + 100000000000 where created_at = (select max(created_at) from __drizzle_migrations)"]);
    const notOurs = path.join(SCRATCH, `${randomUUID()}.db`);
    sqlite(notOurs, ["create table notes (id integer primary key, body text)"]);

    const cases: Array<[label: string, data: Buffer | Promise<Buffer>, message: RegExp]> = [
      ["plain text", Buffer.from("this is not a backup"), /isn't a \.tar\.gz backup/],
      ["half an archive", backup.data.subarray(0, Math.floor(backup.data.length / 2)), /ends too early|damaged/],
      ["an archive without a manifest", archive([{ name: "notes.txt", data: Buffer.from("hello") }]), /manifest\.json/],
      ["another program's manifest", archive([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "something-else" })) }]), /isn't a backup made by this app/],
      ["a manifest from a newer format", archive([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ ...manifest, format_version: 99 })) }]), /newer version/],
      ["a damaged manifest", archive([{ name: "manifest.json", data: Buffer.from("{ not json") }]), /manifest\.json is damaged/],
      ["no database", archive([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }]), /no database/],
      ["a database that doesn't match its manifest", withDb(dbCopy, (m) => (m.database.sha256 = "0".repeat(64))), /doesn't match/],
      ["a file that isn't a database", withDb(Buffer.from("x".repeat(4096))), /can't be opened|integrity check/],
      ["another program's database", withDb(readFileSync(notOurs)), /isn't a database of this app/],
      ["a database from a newer version", withDb(readFileSync(newer)), /newer version/],
      ["a missing secret key", withDb(dbCopy, (m) => (m.secret_key.included = true)), /secret key/],
      ["an unsafe file name", archive([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, { name: "../outside.txt", data: Buffer.from("x") }]), /unsafe name/],
    ];
    for (const [label, data, message] of cases) {
      const res = await upload(owner.client, await data);
      expectStatus(res, 400, label);
      assert.match(res.json().message, message, label);
    }
    assert.equal((await overview()).pending_restore, null);
    assert.equal(existsSync(path.join(TEST_DATA_DIR, "restore-pending")), false);
    assert.deepEqual(readdirSync(TEST_DATA_DIR).filter((n) => n.startsWith(".restore")), [], "no staging or upload files are left behind");
  });

  it("an uploaded backup waits for the next start, and can be cancelled", async () => {
    const o = json(await upload(owner.client, backup.data));
    const pending = o.pending_restore;
    assert.ok(pending, "a restore is waiting");
    assert.equal(pending.source.type, "upload");
    assert.equal(pending.backup.kind, "manual");
    assert.equal(pending.backup.counts.users, 4);
    assert.equal(pending.backup.files, 3);
    assert.equal(pending.backup.secret_key_included, true);
    // APP_SECRET (what these tests use) made the backup and is still set, so the mailbox passwords stay readable.
    assert.equal(pending.secret_matches, true);
    assert.equal(pending.last_attempt, null);
    assert.ok(existsSync(path.join(TEST_DATA_DIR, "restore-pending", "app.db")));

    expectStatus(await owner.client.delete("/api/app/admin/backups/restore"), 200);
    assert.equal((await overview()).pending_restore, null);
    expectStatus(await owner.client.delete("/api/app/admin/backups/restore"), 404);
  });

  it("a backup kept on the server can be chosen too", async () => {
    expectStatus(await owner.client.post("/api/app/admin/backups/backup-2026-01-01-000000-manual.tar.gz/restore", { password: PASSWORD }), 404);
    const o = json(await owner.client.post(`/api/app/admin/backups/${backup.id}/restore`, { password: PASSWORD }));
    assert.deepEqual(o.pending_restore.source, { type: "backup", name: backup.id });
    expectStatus(await owner.client.delete("/api/app/admin/backups/restore"), 200);
  });

  it("stops checking passwords for a while after ten wrong ones", async () => {
    let wrong = 3; // tried above
    for (;;) {
      const res = await owner.client.post(`/api/app/admin/backups/${backup.id}/restore`, { password: "still-the-wrong-password" });
      if (res.statusCode === 429) break;
      expectStatus(res, 400);
      assert.ok(++wrong <= 10, "wrong passwords are limited");
    }
    assert.equal(wrong, 10);
    expectStatus(await owner.client.post(`/api/app/admin/backups/${backup.id}/restore`, { password: PASSWORD }), 429);
    assert.equal((await overview()).pending_restore, null);
  });

  it("swaps the backup in at the next start and keeps what it replaced", async () => {
    const dir = mkdtempSync(path.join(SCRATCH, "data-"));
    writeFileSync(path.join(dir, "app.db"), "the old database");
    writeFileSync(path.join(dir, "app.db-wal"), "the old write-ahead log");
    writeFileSync(path.join(dir, "secret.key"), "the-old-secret");
    mkdirSync(path.join(dir, "attachments", "old"), { recursive: true });
    writeFileSync(path.join(dir, "attachments", "old", "old.txt"), "old attachment");

    await stageRestore(dir, backup.file, { source: { type: "command", name: "test" } });
    // Nothing changes until the restore is applied.
    assert.equal(readFileSync(path.join(dir, "app.db"), "utf8"), "the old database");
    // Folders kept by an earlier restore in the same second are never reused. They cover the next two minutes, since
    // checking for a running engine first can take seconds on a busy machine.
    const earlier = Array.from({ length: 120 }, (_, i) => path.join(dir, "backups", `before-restore-${fileStamp(new Date(Date.now() + i * 1000))}`));
    for (const e of earlier) {
      mkdirSync(e, { recursive: true });
      writeFileSync(path.join(e, "app.db"), "an earlier kept copy");
    }
    const result = applyPendingRestore(dir, { log: () => undefined });
    assert.equal(result.applied, true, result.error);
    for (const e of earlier) assert.equal(readFileSync(path.join(e, "app.db"), "utf8"), "an earlier kept copy");
    for (const e of earlier) rmSync(e, { recursive: true });

    const files = untar(backup.data);
    assert.equal(sha256(readFileSync(path.join(dir, "app.db"))), sha256(files.get("app.db")!));
    assert.equal(existsSync(path.join(dir, "app.db-wal")), false, "the old log can't be replayed into the new database");
    assert.equal(readFileSync(path.join(dir, "secret.key"), "utf8"), SECRET_FILE);
    assert.equal(readFileSync(path.join(dir, "attachments", "ws1", "email1", "quote.pdf"), "utf8"), "pretend pdf");
    assert.equal(existsSync(path.join(dir, "attachments", "old")), false);
    assert.ok(existsSync(path.join(dir, "uploads", "import.csv")));

    const replaced = result.replacedDir!;
    assert.match(path.basename(replaced), /^before-restore-\d{4}-\d{2}-\d{2}-\d{6}-2$/);
    assert.equal(path.dirname(replaced), path.join(dir, "backups"));
    assert.equal(readFileSync(path.join(replaced, "app.db"), "utf8"), "the old database");
    // (The old write-ahead log isn't checked here: looking for a running engine opens the old database, and SQLite then
    // folds the log into it, or drops it for a made-up file like this one.)
    assert.equal(readFileSync(path.join(replaced, "secret.key"), "utf8"), "the-old-secret");
    assert.equal(readFileSync(path.join(replaced, "attachments", "old", "old.txt"), "utf8"), "old attachment");
    assert.equal(readPendingRestore(dir), null);
    assert.equal(readLastRestore(dir)?.replaced_dir, replaced);
    assert.deepEqual(applyPendingRestore(dir, { log: () => undefined }), { applied: false });
  });

  it("waits while a separate engine still uses the data, and puts everything back when a file is locked", async () => {
    const dir = mkdtempSync(path.join(SCRATCH, "data-"));
    // The test runner's own process stands in for a worker that reported a moment ago.
    sqlite(
      path.join(dir, "app.db"),
      ["create table app_settings (key text primary key, value text, updated_at integer)"],
      ["insert into app_settings (key, value) values ('engine_status', ?)", JSON.stringify({ pid: process.ppid, updated_at: new Date().toISOString() })],
    );
    await stageRestore(dir, backup.file, { source: { type: "command", name: "test" } });

    const refused = applyPendingRestore(dir, { log: () => undefined });
    assert.equal(refused.applied, false);
    assert.match(refused.error!, /still running in another process/);
    assert.match(readPendingRestore(dir)?.last_attempt?.error ?? "", /still running/);

    // The worker stopped reporting ten minutes ago.
    sqlite(path.join(dir, "app.db"), [
      "update app_settings set value = ? where key = 'engine_status'",
      JSON.stringify({ pid: process.ppid, updated_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    ]);

    // The last move fails (as when a program holds a file in the folder open on Windows): everything already moved,
    // both ways, must go back.
    mkdirSync(path.join(dir, "uploads"), { recursive: true });
    writeFileSync(path.join(dir, "uploads", "mine.csv"), "still mine");
    const oldDb = sha256(readFileSync(path.join(dir, "app.db")));
    const pendingUploads = path.join(dir, "restore-pending", "uploads");
    const lockedMove = (from: string, to: string) => {
      if (from === pendingUploads) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      renameSync(from, to);
    };
    const blocked = applyPendingRestore(dir, { log: () => undefined, move: lockedMove });
    assert.equal(blocked.applied, false);
    assert.match(blocked.error!, /in use by another program/);
    assert.equal(sha256(readFileSync(path.join(dir, "app.db"))), oldDb, "the old database is back in place");
    assert.equal(readFileSync(path.join(dir, "uploads", "mine.csv"), "utf8"), "still mine");
    assert.equal(existsSync(path.join(dir, "attachments")), false, "nothing from the backup was left in place");
    assert.equal(existsSync(path.join(dir, "secret.key")), false);
    for (const name of ["app.db", "secret.key", "attachments", "uploads"]) assert.ok(existsSync(path.join(dir, "restore-pending", name)), `${name} is still waiting`);
    assert.deepEqual(readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("before-restore-")), [], "the empty folder for replaced files is removed");
    assert.match(readPendingRestore(dir)?.last_attempt?.error ?? "", /in use/);

    const done = applyPendingRestore(dir, { log: () => undefined });
    assert.equal(done.applied, true, done.error);
    assert.ok(existsSync(path.join(dir, "attachments", "ws1", "email1", "quote.pdf")));
  });

  it("waits for a second server or worker standing by too, which has the database open", async () => {
    const dir = mkdtempSync(path.join(SCRATCH, "data-"));
    const note = (value: Record<string, unknown>) => sqlite(path.join(dir, "app.db"), ["update app_settings set value = ? where key = 'engine_standby:other'", JSON.stringify(value)]);
    // The test runner's own process stands in for a second server that noted a moment ago that it's standing by.
    sqlite(
      path.join(dir, "app.db"),
      ["create table app_settings (key text primary key, value text, updated_at integer)"],
      ["insert into app_settings (key, value) values ('engine_standby:other', ?)", JSON.stringify({ pid: process.ppid, host: os.hostname(), updated_at: new Date().toISOString() })],
    );
    await stageRestore(dir, backup.file, { source: { type: "command", name: "test" } });
    const refused = applyPendingRestore(dir, { log: () => undefined });
    assert.equal(refused.applied, false);
    assert.match(refused.error!, new RegExp(`second server or worker is still running on this data \\(pid ${process.ppid}\\)`));

    // On another computer its process can't be looked up: a recent note is enough.
    note({ pid: 999_999, host: "another-computer", updated_at: new Date().toISOString() });
    assert.match(applyPendingRestore(dir, { log: () => undefined }).error ?? "", /pid 999999 on another-computer/);

    // One that stopped noting ten minutes ago is gone.
    note({ pid: process.ppid, host: os.hostname(), updated_at: new Date(Date.now() - 10 * 60_000).toISOString() });
    const done = applyPendingRestore(dir, { log: () => undefined });
    assert.equal(done.applied, true, done.error);
  });

  it("refuses a backup holding more files than its manifest says", async () => {
    const files = untar(backup.data);
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
    const file = path.join(SCRATCH, `${randomUUID()}.tar.gz`);
    await writeTarGz(file, [
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ ...manifest, folders: { uploads: { files: 1, bytes: 2 } } })) },
      { name: "app.db", data: files.get("app.db")! },
      { name: "secret.key", data: files.get("secret.key")! },
      { name: "uploads/a.csv", data: Buffer.from("a") },
      { name: "uploads/b.csv", data: Buffer.from("b") },
    ]);
    const dir = mkdtempSync(path.join(SCRATCH, "data-"));
    await assert.rejects(stageRestore(dir, file, { source: { type: "command", name: "test" } }), /more files than its manifest says/);
    assert.equal(readPendingRestore(dir), null);
  });

  it("what an interrupted upload or check left behind goes after a day", async () => {
    const dir = mkdtempSync(path.join(SCRATCH, "data-"));
    const old = new Date(Date.now() - 2 * 86_400_000);
    mkdirSync(path.join(dir, ".restore-staging-abc", "attachments"), { recursive: true });
    writeFileSync(path.join(dir, ".restore-staging-abc", "app.db"), "half a database");
    writeFileSync(path.join(dir, ".restore-upload-0a1b.tar.gz"), "half an upload");
    mkdirSync(path.join(dir, "restore-command"));
    mkdirSync(path.join(dir, "restore-pending"));
    writeFileSync(path.join(dir, ".restore-upload-2c3d.tar.gz"), "an upload going on now");
    for (const name of [".restore-staging-abc", ".restore-upload-0a1b.tar.gz", "restore-command", "restore-pending"]) utimesSync(path.join(dir, name), old, old);
    assert.equal(await removeRestoreLeftovers(dir), 3);
    assert.deepEqual(readdirSync(dir).sort(), [".restore-upload-2c3d.tar.gz", "restore-pending"], "a restore that's waiting stays, however old");
  });

  it("npm run restore leaves a restore chosen on the Backups page waiting when it isn't told to go ahead", { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(path.join(SCRATCH, "cli-"));
    await stageRestore(dir, backup.file, { source: { type: "upload", name: "chosen-on-the-page.tar.gz" } });
    const tsxCli = createRequire(path.join(SERVER_DIR, "package.json")).resolve("tsx/cli");
    // No --yes, and no terminal to ask in: it doesn't go ahead.
    const run = spawnSync(process.execPath, [tsxCli, "src/scripts/restore.ts", path.basename(backup.file)], {
      cwd: SERVER_DIR,
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dir, PORT: "9", INIT_CWD: SCRATCH },
      timeout: 110_000,
    });
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /still waiting/);
    assert.equal(readPendingRestore(dir)?.source.name, "chosen-on-the-page.tar.gz");
    assert.equal(existsSync(path.join(dir, "restore-command")), false);
  });

  it("npm run restore restores a backup into a stopped installation's data folder", { timeout: 120_000 }, () => {
    const dir = mkdtempSync(path.join(SCRATCH, "cli-"));
    const tsxCli = createRequire(path.join(SERVER_DIR, "package.json")).resolve("tsx/cli");
    const run = spawnSync(process.execPath, [tsxCli, "src/scripts/restore.ts", path.basename(backup.file), "--yes"], {
      cwd: SERVER_DIR,
      encoding: "utf8",
      // A port nothing listens on, so it doesn't find a running server.
      env: { ...process.env, DATA_DIR: dir, PORT: "9", INIT_CWD: SCRATCH },
      timeout: 110_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Restored\./);
    assert.equal(sha256(readFileSync(path.join(dir, "app.db"))), sha256(untar(backup.data).get("app.db")!));
    assert.equal(readFileSync(path.join(dir, "secret.key"), "utf8"), SECRET_FILE);
  });

  it("works out DATA_DIR the way the server does", () => {
    assert.equal(dataDirFromEnv(), config.dataDir);
  });

  it("refuses entry names that could escape the folder", () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "a\\b", "C:/x", "a//b", "./", ""]) assert.equal(safeEntryPath(bad), null, bad);
    assert.deepEqual(safeEntryPath("./attachments/a b/c.pdf"), ["attachments", "a b", "c.pdf"]);
  });
});

// ---------- After a restore ----------

describe("the first start after a restore", () => {
  it("pauses the campaigns that were sending and holds scheduled emails that were due, once", async () => {
    const cara = await signUp(app, { firstName: "Cara", workspaceName: "Cara Co" });
    const campaign = async (name: string, status: number) => {
      const id = json(await cara.client.post("/api/app/campaigns", { name })).id as string;
      await db.update(schema.campaigns).set({ status }).where(eq(schema.campaigns.id, id));
      return id;
    };
    const ids = {
      sending: await campaign("Sending", CampaignStatus.ACTIVE),
      subsequences: await campaign("Running subsequences", CampaignStatus.RUNNING_SUBSEQUENCES),
      unhealthy: await campaign("Waiting for a mailbox", CampaignStatus.ACCOUNTS_UNHEALTHY),
      draft: await campaign("Draft", CampaignStatus.DRAFT),
      done: await campaign("Done", CampaignStatus.COMPLETED),
      bounces: await campaign("Too many bounces", CampaignStatus.BOUNCE_PROTECT),
    };
    const restoredAt = new Date(Date.now() - 60_000);
    const scheduled = (messageId: string, scheduledAt: Date) => ({
      workspaceId: cara.workspaceId!,
      messageId,
      ueType: EmailType.SCHEDULED,
      scheduledAt,
      timestampEmail: scheduledAt,
      subject: "Later",
      bodyText: "Hello",
      eaccount: "mailbox@cara.example.test",
      leadEmail: "lead@cara.example.test",
    });
    const [due, later] = await db
      .insert(schema.emails)
      .values([scheduled("<due@cara.example.test>", new Date(restoredAt.getTime() - 3_600_000)), scheduled("<later@cara.example.test>", new Date(Date.now() + 86_400_000))])
      .returning();
    const lastFile = path.join(TEST_DATA_DIR, "backups", "last-restore.json");
    const restore = { restored_at: restoredAt.toISOString(), backup_created_at: "2026-10-15T03:00:00.000Z", source: { type: "backup", name: "test" }, replaced_dir: path.join(TEST_DATA_DIR, "backups", "before-restore-test") };
    try {
      // A restore from before this check existed doesn't pause anything.
      writeFileSync(lastFile, JSON.stringify(restore));
      assert.equal(await pauseSendingAfterRestore(), null);
      assert.equal((await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, ids.sending)))[0]!.status, CampaignStatus.ACTIVE);

      writeFileSync(lastFile, JSON.stringify({ ...restore, pause_pending: true }));
      assert.deepEqual(await pauseSendingAfterRestore(), { campaigns: 3, scheduled_emails: 1 });
      const status = async (id: string) => (await db.select({ s: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]!.s;
      for (const id of [ids.sending, ids.subsequences, ids.unhealthy]) assert.equal(await status(id), CampaignStatus.PAUSED);
      assert.equal(await status(ids.draft), CampaignStatus.DRAFT);
      assert.equal(await status(ids.done), CampaignStatus.COMPLETED);
      assert.equal(await status(ids.bounces), CampaignStatus.BOUNCE_PROTECT);
      const email = async (id: string) => (await db.select().from(schema.emails).where(eq(schema.emails.id, id)))[0]!;
      const held = await email(due!.id);
      assert.equal(held.scheduledAt, null);
      assert.match(held.sendError ?? "", /Held after the restore/);
      assert.equal((await email(later!.id)).scheduledAt?.getTime(), later!.scheduledAt!.getTime(), "an email due after the restore can't have gone out");

      const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.workspaceId, cara.workspaceId!));
      assert.equal(notes.length, 1);
      assert.equal(notes[0]!.type, "sending_paused");
      assert.equal(notes[0]!.link, "/app/campaigns?status=paused");
      assert.match(notes[0]!.body ?? "", /3 campaigns that were sending are paused and 1 scheduled email that was due is held/);

      assert.deepEqual(readLastRestore(TEST_DATA_DIR)?.paused, { campaigns: 3, scheduled_emails: 1 });
      assert.equal(readLastRestore(TEST_DATA_DIR)?.pause_pending, undefined);
      assert.deepEqual((await overview()).last_restore.paused, { campaigns: 3, scheduled_emails: 1 });

      // Once: a campaign resumed after that keeps sending through the next start.
      await db.update(schema.campaigns).set({ status: CampaignStatus.ACTIVE }).where(eq(schema.campaigns.id, ids.sending));
      assert.equal(await pauseSendingAfterRestore(), null);
      assert.equal(await status(ids.sending), CampaignStatus.ACTIVE);
    } finally {
      rmSync(lastFile, { force: true });
    }
  });
});

// ---------- Automatic backups ----------

describe("automatic backups", () => {
  const at = (iso: string) => DateTime.fromISO(iso, { zone: "Europe/London" });

  it("the schedule only takes known values", async () => {
    for (const bad of [{ frequency: "hourly" }, { hour: 24 }, { hour: -1 }, { weekday: 0 }, { keep: 0 }, { keep: 101 }, { surprise: true }]) {
      expectStatus(await owner.client.patch("/api/app/admin/backups/schedule", bad), 400, JSON.stringify(bad));
    }
    const o = json(await owner.client.patch("/api/app/admin/backups/schedule", { frequency: "weekly", hour: 4, weekday: 3, keep: 3 }));
    assert.deepEqual(o.schedule, { frequency: "weekly", hour: 4, weekday: 3, keep: 3 });
    const next = DateTime.fromISO(o.next_automatic_at).setZone(o.time_zone);
    assert.ok(next > DateTime.now(), "turning it on doesn't start one at once");
    assert.equal(next.weekday, 3);
    assert.equal(next.hour, 4);
    assert.deepEqual(json(await owner.client.get("/api/app/admin/settings")).backups, o.schedule);
    expectStatus(await admin.client.patch("/api/app/admin/backups/schedule", { frequency: "off" }), 403);
  });

  it("knows when one is due: once per scheduled time, not before the schedule was set, and not right after a failure", () => {
    const daily = { frequency: "daily" as const, hour: 3, weekday: 7, keep: 7 };
    assert.equal(lastSlot(daily, at("2026-10-15T02:59"))?.toISO(), at("2026-10-14T03:00").toISO());
    assert.equal(nextSlot(daily, at("2026-10-15T03:00"))?.toISO(), at("2026-10-16T03:00").toISO());
    const weekly = { frequency: "weekly" as const, hour: 3, weekday: 7, keep: 7 };
    assert.equal(lastSlot(weekly, at("2026-10-15T12:00"))?.toISO(), at("2026-10-11T03:00").toISO()); // the Sunday before
    assert.equal(lastSlot({ ...daily, frequency: "off" }, at("2026-10-15T12:00")), null);

    const changed = { schedule_changed_at: at("2026-10-14T12:00").toUTC().toISO() };
    assert.equal(automaticBackupDue(daily, changed, at("2026-10-15T02:59"), null), false);
    assert.equal(automaticBackupDue(daily, changed, at("2026-10-15T03:00"), null), true);
    assert.equal(automaticBackupDue(daily, changed, at("2026-10-15T09:30"), null), true, "a time missed while the server was down is caught up");
    assert.equal(automaticBackupDue(daily, { ...changed, last_automatic_at: at("2026-10-15T03:00:05").toUTC().toISO() }, at("2026-10-15T09:00"), null), false);
    assert.equal(automaticBackupDue(daily, changed, at("2026-10-15T09:00"), at("2026-10-15T03:00:05").toUTC().toISO()), false, "a backup file counts too");
    const failed = { ...changed, last_failed_attempt_at: at("2026-10-15T08:50").toUTC().toISO() };
    assert.equal(automaticBackupDue(daily, failed, at("2026-10-15T09:00"), null), false);
    assert.equal(automaticBackupDue(daily, failed, at("2026-10-15T09:21"), null), true);
  });

  it("the engine loop makes one when it's due and keeps only the newest automatic ones", async () => {
    json(await owner.client.patch("/api/app/admin/backups/schedule", { frequency: "daily", hour: 0, keep: 2 }));
    // Pretend the schedule was set long ago and older automatic backups exist.
    await setAppSetting("backup_state", { schedule_changed_at: "2020-01-01T00:00:00.000Z" });
    for (const day of ["01", "02", "03"]) writeFileSync(path.join(TEST_DATA_DIR, "backups", `backup-2020-01-${day}-000000-automatic.tar.gz`), backup.data);
    await runScheduledBackup();
    const list = await listBackups();
    const automatic = list.filter((b) => b.kind === "automatic");
    assert.equal(automatic.length, 2);
    assert.ok(Date.now() - Date.parse(automatic[0]!.created_at) < 60_000, "the new one is kept");
    assert.equal(automatic[1]!.id, "backup-2020-01-03-000000-automatic.tar.gz");
    assert.ok(list.some((b) => b.id === backup.id), "backups made by hand are never deleted automatically");
    const o = await overview();
    assert.equal(o.last.kind, "automatic");
    // Not due again until the next scheduled time.
    await runScheduledBackup();
    assert.equal((await listBackups()).filter((b) => b.kind === "automatic").length, 2);
    json(await owner.client.patch("/api/app/admin/backups/schedule", { frequency: "off" }));
  });
});

// ---------- Download all data ----------

describe("download all data", () => {
  let jobId = "";
  let files: Map<string, Buffer>;
  let folder = "";

  before(async () => {
    const c = alice.client;
    const accounts = [
      { email: "mailbox@alice.example.test", imap_password: IMAP_PASSWORD, smtp_password: SMTP_PASSWORD },
    ];
    for (const a of accounts) {
      expectStatus(await c.post("/api/v2/accounts", { email: a.email, imap_host: "203.0.113.25", smtp_host: "203.0.113.25", imap_password: a.imap_password, smtp_password: a.smtp_password, skip_connection_test: true }), 200);
    }
    // An account connected with OAuth, and a saved AI key: neither may show up.
    await db.insert(schema.emailAccounts).values({ workspaceId: alice.workspaceId!, email: "oauth@alice.example.test", providerCode: 2, oauthEnc: encrypt(JSON.stringify({ access_token: OAUTH_TOKEN, refresh_token: OAUTH_TOKEN })) });
    await db.update(schema.workspaces).set({ settings: { default_timezone: "Europe/London", anthropic_api_key_enc: encrypt(AI_KEY) } }).where(eq(schema.workspaces.id, alice.workspaceId!));

    const campaign = json(await c.post("/api/app/campaigns", { name: "Alice's outreach" }));
    json(await c.post("/api/v2/leads/add", { campaign_id: campaign.id, leads: [{ email: "lead-one@alice.example.test", first_name: "Lee", custom_variables: { favourite_colour: "teal", score: 7 } }] }));
    const list = json(await c.post("/api/v2/lead-lists", { name: "Alice's list" }));
    json(await c.post("/api/v2/leads", { email: "listed@alice.example.test", list_id: list.id }));
    json(await c.post("/api/v2/block-lists-entries", { bl_value: "blocked@alice.example.test" }));
    json(await c.post("/api/v2/custom-tags", { label: "Alice tag" }));
    const thread = `thread-${randomUUID()}`;
    await db.insert(schema.emails).values([
      { workspaceId: alice.workspaceId!, messageId: "<first@alice.example.test>", threadId: thread, subject: "Quick question", bodyText: "Hello Lee", bodyHtml: "<p>Hello Lee</p>", eaccount: "mailbox@alice.example.test", ueType: 1, leadEmail: "lead-one@alice.example.test", campaignId: campaign.id, timestampEmail: new Date(Date.now() - 7_200_000) },
      { workspaceId: alice.workspaceId!, messageId: "<reply@alice.example.test>", threadId: thread, inReplyTo: "<first@alice.example.test>", references: "<first@alice.example.test>", subject: "Re: Quick question", bodyText: "Sounds good", eaccount: "mailbox@alice.example.test", ueType: 2, leadEmail: "lead-one@alice.example.test", timestampEmail: new Date(Date.now() - 3_600_000) },
    ]);

    // Bob's workspace, which must never show up in Alice's export.
    const bobCampaign = json(await bob.client.post("/api/app/campaigns", { name: "Bob's campaign" }));
    json(await bob.client.post("/api/v2/leads", { email: "bob-lead@bob.example.test", campaign: bobCampaign.id }));
    expectStatus(await bob.client.post("/api/v2/accounts", { email: "mailbox@bob.example.test", imap_host: "203.0.113.25", smtp_host: "203.0.113.25", imap_password: "bob-imap-pass-5", smtp_password: "bob-smtp-pass-6", skip_connection_test: true }), 200);
    await db.insert(schema.emails).values({ workspaceId: bob.workspaceId!, messageId: "<bob@bob.example.test>", subject: "Bob's private email", bodyText: "Bob's words", eaccount: "mailbox@bob.example.test", ueType: 1, leadEmail: "bob-lead@bob.example.test", timestampEmail: new Date() });

    const job = json(await c.post("/api/app/workspace-export"));
    jobId = job.id;
    assert.equal(json(await c.post("/api/app/workspace-export")).id, jobId, "asking again while it's being prepared gives the same export");
    await runPendingJobs();
    await waitFor(async () => {
      const latest = json(await c.get("/api/app/workspace-export")).items[0];
      if (latest.status === "failed") assert.fail(`the export failed: ${latest.error}`);
      return latest.status === "success";
    }, "the export");
    const res = await c.get(`/api/app/workspace-export/${jobId}/download`);
    expectStatus(res, 200);
    assert.match(String(res.headers["content-disposition"]), /filename="alice-co-export-\d{4}-\d{2}-\d{2}\.tar\.gz"/);
    files = untar(res.rawPayload);
    folder = [...files.keys()][0]!.split("/")[0]!;
  });

  const text = (name: string) => files.get(`${folder}/${name}`)?.toString("utf8") ?? "";
  const csv = (name: string) => text(name).replace(/^\uFEFF/, "").trim().split(/\r?\n/);

  it("holds the workspace's leads, lists, campaigns, accounts, emails, block list and tags", async () => {
    assert.match(folder, /^alice-co-export-\d{4}-\d{2}-\d{2}$/);
    const names = [...files.keys()].map((n) => n.slice(folder.length + 1)).sort();
    assert.deepEqual(names, ["README.txt", "block-list.csv", "campaigns.json", "email-accounts.csv", "emails.json", "lead-labels.csv", "lead-lists.csv", "leads.csv", "tags.csv", "unsubscribes.csv", "workspace.json"]);

    const leads = csv("leads.csv");
    const header = leads[0]!.split(",");
    assert.ok(header.includes("email") && header.includes("campaign_name") && header.includes("favourite_colour") && header.includes("score"), leads[0]);
    const lee = leads.find((l) => l.includes("lead-one@alice.example.test"))!;
    assert.ok(lee.includes("teal") && lee.includes("Alice's outreach"), lee);
    assert.ok(leads.some((l) => l.includes("listed@alice.example.test") && l.includes("Alice's list")));
    assert.ok(csv("lead-lists.csv").some((l) => l.includes("Alice's list") && l.includes(",1,")), "the list and its one lead");

    const campaigns = JSON.parse(text("campaigns.json"));
    assert.equal(campaigns.length, 1);
    assert.equal(campaigns[0].name, "Alice's outreach");
    assert.ok(Array.isArray(campaigns[0].sequences[0]?.steps?.[0]?.variants), "sequences with their steps and variants");
    assert.ok(campaigns[0].campaign_schedule.schedules.length >= 1);
    assert.equal(campaigns[0].lead_count, 1);

    const accounts = csv("email-accounts.csv").join("\n");
    assert.ok(accounts.includes("mailbox@alice.example.test") && accounts.includes("oauth@alice.example.test"));

    const threads = JSON.parse(text("emails.json"));
    const t = threads.find((x: { emails: unknown[] }) => x.emails.length === 2);
    assert.ok(t, "the two emails are one thread");
    assert.equal(t.emails[0].message_id, "<first@alice.example.test>");
    assert.equal(t.emails[0].body.html, "<p>Hello Lee</p>");
    assert.equal(t.emails[1].in_reply_to, "<first@alice.example.test>");
    assert.equal(t.emails[1].body.text, "Sounds good");

    assert.ok(csv("block-list.csv").some((l) => l.includes("blocked@alice.example.test")));
    assert.ok(csv("tags.csv").some((l) => l.includes("Alice tag")));
    const ws = JSON.parse(text("workspace.json"));
    assert.equal(ws.name, "Alice Co");
    assert.equal(ws.counts.leads, 2);
    assert.equal(ws.counts.emails, 2);
    assert.equal(ws.settings.default_timezone, "Europe/London");

    const view = json(await alice.client.get("/api/app/workspace-export")).items[0];
    assert.equal(view.available, true);
    assert.ok(view.bytes > 0 && Date.parse(view.expires_at) > Date.now());
  });

  it("never holds a password, token, key or anything encrypted", () => {
    const all = [...files.values()].map((b) => b.toString("utf8")).join("\n");
    for (const secret of [IMAP_PASSWORD, SMTP_PASSWORD, OAUTH_TOKEN, AI_KEY, "v1:", "_sealed"]) assert.ok(!all.includes(secret), `the export contains ${secret}`);
    const secretKey = /password|passwd|secret|token|api_?key|_enc$/i;
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    for (const [name, data] of files) {
      if (name.endsWith(".json")) walk(JSON.parse(data.toString("utf8")));
      if (name.endsWith(".csv")) for (const h of data.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/)[0]!.split(",")) keys.add(h.replace(/"/g, ""));
    }
    assert.deepEqual([...keys].filter((k) => secretKey.test(k)), []);
  });

  it("holds nothing from another workspace, and other workspaces can't see or download it", async () => {
    const all = [...files.values()].map((b) => b.toString("utf8")).join("\n");
    for (const theirs of ["bob-lead@bob.example.test", "mailbox@bob.example.test", "Bob's private email", "Bob's campaign", "bob-imap-pass-5"]) assert.ok(!all.includes(theirs), `the export contains ${theirs}`);
    assert.deepEqual(json(await bob.client.get("/api/app/workspace-export")).items, []);
    expectStatus(await bob.client.get(`/api/app/workspace-export/${jobId}/download`), 404);
  });

  it("finishes when it runs again after the app stopped in the middle of it", async () => {
    const dana = await signUp(app, { firstName: "Dana", workspaceName: "Dana Co" });
    const job = json(await dana.client.post("/api/app/workspace-export"));
    // What the stopped try left: the archive it was writing.
    writeFileSync(`${workspaceExportFile(job.id)}.partial`, "half an archive");
    await runPendingJobs();
    await waitFor(async () => {
      const latest = json(await dana.client.get("/api/app/workspace-export")).items[0];
      if (latest.status === "failed") assert.fail(`the export failed: ${latest.error}`);
      return latest.status === "success";
    }, "the export");
    expectStatus(await dana.client.get(`/api/app/workspace-export/${job.id}/download`), 200);
  });

  it("lead exports go after a week, like workspace exports; Lead Finder's stay", async () => {
    const dir = path.join(TEST_DATA_DIR, "exports");
    const old = new Date(Date.now() - 8 * 86_400_000);
    const [leads, finder, fresh] = [randomUUID(), randomUUID(), randomUUID()].map((id) => `${id}.csv`);
    for (const name of [leads!, finder!, fresh!]) writeFileSync(path.join(dir, name), "email\n");
    for (const name of [leads!, finder!]) utimesSync(path.join(dir, name), old, old);
    await db.insert(schema.lfExports).values({ workspaceId: alice.workspaceId!, name: "Found leads", count: 1, filePath: finder!, createdBy: alice.id });
    await removeOldExports();
    assert.equal(existsSync(path.join(dir, leads!)), false);
    assert.ok(existsSync(path.join(dir, finder!)), "a Lead Finder export is listed, so it's kept");
    assert.ok(existsSync(path.join(dir, fresh!)));
  });

  it("is for the workspace's owners and admins only", async () => {
    const invitee = uniqueEmail("editor");
    const invite = json(await alice.client.post("/api/v2/workspace-members", { email: invitee, role: "editor" }));
    const editor = await signUp(app, { email: invitee, inviteToken: new URL(invite.invite_url).searchParams.get("token")! });
    assert.equal(editor.me.membership.role, "editor");
    expectStatus(await editor.client.get("/api/app/workspace-export"), 403);
    expectStatus(await editor.client.post("/api/app/workspace-export"), 403);
    expectStatus(await editor.client.get(`/api/app/workspace-export/${jobId}/download`), 403);
    const key = json(await alice.client.post("/api/v2/api-keys", { name: "Everything", scopes: ["all:all"] })).key as string;
    expectStatus(await new TestClient(app, key).post("/api/app/workspace-export"), 403);
  });
});
