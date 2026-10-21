// Restoring a backup. The archive is checked and unpacked next to the data, in DATA_DIR/restore-pending; the swap
// happens at the next start, before the database or the secret key is opened (src/restore-on-start.ts), because a live
// SQLite file can't be replaced under a running server. `npm run restore` (src/scripts/restore.ts) does both steps
// offline. Whatever a restore replaces is kept in DATA_DIR/backups/before-restore-<time>/. Like ./backup-archive,
// nothing here may import the app's settings or database.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveError, libsqlModulePath, parseManifest, readTarGz, safeEntryPath, secretFingerprint, sqliteTask, type BackupManifest, type TarEntry } from "./backup-archive";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../../..");

export const PENDING_DIR = "restore-pending";
/** Where `npm run restore` checks a backup before it's told to go ahead (a restore that's waiting stays as it is). */
export const COMMAND_DIR = "restore-command";
/** An uploaded backup while it's received and checked, in DATA_DIR (removed once that's done). */
export const UPLOAD_PREFIX = ".restore-upload-";
const STAGING_PREFIX = ".restore-staging-";
const REQUEST_FILE = "restore.json";
const ATTEMPT_FILE = "attempt.json";
const LAST_RESTORE_FILE = "last-restore.json";
/** Folders a backup carries besides the database and the secret key. Anything else in an archive is ignored. */
export const BACKUP_FOLDERS = ["attachments", "uploads"] as const;
const REQUIRED_TABLES = ["users", "workspaces", "app_settings", "__drizzle_migrations"];
const MB = 1024 * 1024;
const DAY = 86_400_000;

/** DATA_DIR resolved the way src/env.ts resolves it (env.ts itself can't load before a restore: it reads the secret key). */
export function dataDirFromEnv(): string {
  const v = process.env.DATA_DIR;
  return path.resolve(REPO_ROOT, v === undefined || v === "" ? "./data" : v);
}

/** The newest migration this version of the app knows (from drizzle's journal), or null when it can't be read. */
export function latestKnownMigration(): number | null {
  try {
    const journal = JSON.parse(readFileSync(path.resolve(here, "../../drizzle/meta/_journal.json"), "utf8")) as { entries?: Array<{ when?: unknown }> };
    const times = (journal.entries ?? []).map((e) => Number(e.when)).filter((n) => Number.isFinite(n));
    return times.length ? Math.max(...times) : null;
  } catch {
    return null;
  }
}

export function formatBytes(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** UTC time for file and folder names: 2026-10-15-064200. */
export function fileStamp(at: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface RestoreSource {
  /** upload: sent from the Backups page; backup: one of the backups on this server; command: npm run restore. */
  type: "upload" | "backup" | "command";
  name: string;
}

export interface PendingRestore {
  staged_at: string;
  staged_by: string | null;
  source: RestoreSource;
  backup: {
    created_at: string;
    kind: "manual" | "automatic";
    app: { name: string; version: string };
    database_bytes: number;
    counts: Record<string, number | null>;
    files: number;
    secret_key_included: boolean;
    /** Where the key came from when the backup was made: DATA_DIR/secret.key, or the APP_SECRET setting. */
    secret_key_source: "file" | "environment";
  };
  /** Whether the secret key the server will use after restarting is the one the backup was made with. */
  secret_matches: boolean;
  /** The last time the server tried to finish this restore and couldn't. */
  last_attempt: { at: string; error: string } | null;
}

export interface LastRestore {
  restored_at: string;
  backup_created_at: string;
  source: RestoreSource;
  /** Where the replaced database, secret key and folders were moved. */
  replaced_dir: string;
  /** Set by the restore until the next start has paused what was sending (services/backups.ts pauseSendingAfterRestore). */
  pause_pending?: boolean;
  /** What that start paused: campaigns that were sending, and scheduled emails that were due by the restore. */
  paused?: { campaigns: number; scheduled_emails: number };
}

export function readPendingRestore(dataDir: string): PendingRestore | null {
  const dir = path.join(dataDir, PENDING_DIR);
  const request = readJson<PendingRestore>(path.join(dir, REQUEST_FILE));
  return request ? { ...request, last_attempt: readJson(path.join(dir, ATTEMPT_FILE)) } : null;
}

export function readLastRestore(dataDir: string): LastRestore | null {
  return readJson<LastRestore>(path.join(dataDir, "backups", LAST_RESTORE_FILE));
}

export function writeLastRestore(dataDir: string, last: LastRestore) {
  writeFileSync(path.join(dataDir, "backups", LAST_RESTORE_FILE), JSON.stringify(last, null, 2));
}

/** Drops a restore that's waiting for the next start. False when there was none. */
export async function cancelPendingRestore(dataDir: string): Promise<boolean> {
  const dir = path.join(dataDir, PENDING_DIR);
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** The secret key the server will use after it restarts, the way src/env.ts picks it. */
function secretAfterRestart(dataDir: string, stagedSecret: string | null): string | null {
  const env = process.env.APP_SECRET ?? "";
  if (env.length >= 32) return env;
  try {
    return readFileSync(stagedSecret ?? path.join(dataDir, "secret.key"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function readSmall(entry: TarEntry, max: number): Promise<Buffer> {
  if (entry.size > max) throw new ArchiveError(`"${entry.name}" is bigger than it can be in a backup.`);
  const parts: Buffer[] = [];
  for await (const chunk of entry.content()) parts.push(chunk);
  return Buffer.concat(parts);
}

/** Streams an entry into a new file and waits until the file is closed (Windows won't move open files). */
async function writeEntry(entry: TarEntry, file: string, onChunk?: (chunk: Buffer) => void) {
  await mkdir(path.dirname(file), { recursive: true });
  const out = createWriteStream(file, { flags: "wx" });
  const closed = once(out, "close");
  closed.catch(() => undefined);
  try {
    for await (const chunk of entry.content()) {
      onChunk?.(chunk);
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
  } catch (err) {
    out.destroy();
    throw err;
  }
  await closed;
}

/**
 * Checks a backup archive and unpacks it into DATA_DIR/restore-pending, replacing any restore that was waiting. The
 * swap itself happens at the next start (applyPendingRestore). Throws an ArchiveError, worded for the owner, when the
 * file isn't a sound backup of this app. `into` unpacks it into another folder of DATA_DIR instead.
 */
export async function stageRestore(dataDir: string, archive: string, opts: { source: RestoreSource; stagedBy?: string | null; into?: string }): Promise<PendingRestore> {
  await mkdir(dataDir, { recursive: true });
  const staging = await mkdtemp(path.join(dataDir, STAGING_PREFIX));
  try {
    let manifest: BackupManifest | null = null;
    const hash = createHash("sha256");
    let dbBytes = 0;
    let haveDb = false;
    let haveSecret = false;
    let files = 0;
    let fileLimit = Infinity;
    let unpacked = 0;
    let limit = Infinity;
    for await (const entry of readTarGz(archive)) {
      if (entry.type === "directory") continue;
      const parts = safeEntryPath(entry.name);
      if (!parts) throw new ArchiveError(`The backup holds a file with an unsafe name ("${entry.name.slice(0, 120)}").`);
      if (entry.type !== "file") throw new ArchiveError("The backup holds links or special files, which backups never have.");
      const name = parts.join("/");
      if (!manifest) {
        if (name !== "manifest.json") throw new ArchiveError("This file isn't a backup made by this app (it doesn't start with manifest.json).");
        let raw: unknown;
        try {
          raw = JSON.parse((await readSmall(entry, MB)).toString("utf8"));
        } catch (err) {
          throw err instanceof ArchiveError ? err : new ArchiveError("This backup's manifest.json is damaged.");
        }
        manifest = parseManifest(raw);
        const declared = manifest.database.bytes + Object.values(manifest.folders).reduce((n, f) => n + f.bytes, 0);
        limit = declared + 64 * MB;
        fileLimit = Object.values(manifest.folders).reduce((n, f) => n + f.files, 0);
        const free = await freeBytes(dataDir);
        if (free !== null && free < declared + 64 * MB) {
          throw new ArchiveError(`There isn't enough free disk space to unpack this backup: it needs about ${formatBytes(declared + 64 * MB)} and ${formatBytes(free)} is free.`);
        }
        continue;
      }
      if (name === "app.db") {
        if (haveDb) throw new ArchiveError("The backup holds two databases.");
        await writeEntry(entry, path.join(staging, "app.db"), (chunk) => {
          hash.update(chunk);
          dbBytes += chunk.length;
        });
        haveDb = true;
      } else if (name === "secret.key") {
        const key = await readSmall(entry, 4096);
        await writeFile(path.join(staging, "secret.key"), key, { mode: 0o600 });
        haveSecret = true;
      } else if ((BACKUP_FOLDERS as readonly string[]).includes(parts[0]!) && parts.length > 1) {
        if (++files > fileLimit) throw new ArchiveError("The backup holds more files than its manifest says. It may be damaged.");
        await writeEntry(entry, path.join(staging, ...parts));
      } else continue;
      unpacked += entry.size;
      if (unpacked > limit) throw new ArchiveError("The backup holds more data than its manifest says. It may be damaged.");
    }
    if (!manifest) throw new ArchiveError("This file isn't a backup made by this app (manifest.json is missing).");
    if (!haveDb) throw new ArchiveError("The backup has no database (app.db).");
    if (dbBytes !== manifest.database.bytes || hash.digest("hex") !== manifest.database.sha256) {
      throw new ArchiveError("The database in this backup is damaged: it doesn't match the backup's manifest.");
    }
    if (manifest.secret_key.included && !haveSecret) throw new ArchiveError("The backup's secret key (secret.key) is missing.");

    let info;
    try {
      info = await sqliteTask({ op: "inspect", file: path.join(staging, "app.db") });
    } catch (err) {
      throw new ArchiveError(`The database in this backup can't be opened (${(err as Error).message}).`);
    }
    if (info.check?.join(" ") !== "ok") throw new ArchiveError("The database in this backup failed its integrity check.");
    if (REQUIRED_TABLES.some((t) => !info.tables.includes(t))) throw new ArchiveError("The database in this backup isn't a database of this app.");
    const known = latestKnownMigration();
    if (known !== null && info.migration_at !== null && info.migration_at > known) {
      throw new ArchiveError("This backup was made by a newer version of the app. Update this installation, then restore it.");
    }

    const secret = secretAfterRestart(dataDir, haveSecret ? path.join(staging, "secret.key") : null);
    const pending: PendingRestore = {
      staged_at: new Date().toISOString(),
      staged_by: opts.stagedBy ?? null,
      source: opts.source,
      backup: {
        created_at: manifest.created_at,
        kind: manifest.kind,
        app: { name: manifest.app.name, version: manifest.app.version },
        database_bytes: manifest.database.bytes,
        counts: info.counts,
        files,
        secret_key_included: haveSecret,
        secret_key_source: manifest.secret_key.source,
      },
      secret_matches: !!secret && secretFingerprint(secret) === manifest.secret_key.fingerprint,
      last_attempt: null,
    };
    await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(staging, REQUEST_FILE), JSON.stringify(pending, null, 2));
    const pendingDir = path.join(dataDir, opts.into ?? PENDING_DIR);
    await rm(pendingDir, { recursive: true, force: true });
    await rename(staging, pendingDir);
    return pending;
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------- Applying (synchronous: it runs before anything else at startup) ----------

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Renames, retrying while Windows still holds the file for a moment, and copying across disks when it must. */
function moveSync(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
        rmSync(from, { recursive: true, force: true });
        return;
      }
      if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < 10) {
        sleepSync(200);
        continue;
      }
      throw err;
    }
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Plain JavaScript for a short-lived node process. The driver keeps a database file open after close() until its
// statements are collected, and Windows can't move an open file, so the check runs in a process of its own: when that
// process exits, the file is free.
const ENGINE_STATUS_SOURCE = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2]);
const rows = [];
try {
  for (const row of db.prepare("select key, value from app_settings where key = 'engine_status' or key like 'engine_standby:%'").all()) {
    if (typeof row.value === "string") rows.push({ key: String(row.key), value: row.value });
  }
} catch {}
try { db.close(); } catch {}
process.stdout.write(JSON.stringify(rows));
`;

function readStatus(text: string): { pid?: unknown; host?: unknown; updated_at?: unknown } | null {
  try {
    return JSON.parse(text) as { pid?: unknown; host?: unknown; updated_at?: unknown } | null;
  } catch {
    return null;
  }
}

/**
 * Another process using this data that reported in the last 75 seconds and is still running: the background engine
 * (a separate worker), or a second server or worker standing by to take it over (engine/lease.ts).
 */
export function liveEngineElsewhere(dbFile: string): { pid: number; host: string | null; standby: boolean } | null {
  // The driver would create a missing file.
  if (!existsSync(dbFile)) return null;
  const run = spawnSync(process.execPath, ["-e", ENGINE_STATUS_SOURCE, libsqlModulePath(), dbFile], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (run.status !== 0 || !run.stdout) return null;
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = JSON.parse(run.stdout) as Array<{ key: string; value: string }>;
  } catch {
    return null;
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = readStatus(row.value);
    const pid = Number(status?.pid);
    const age = Date.now() - Date.parse(String(status?.updated_at));
    if (!pid || !(age < 75_000)) continue;
    // A process on another computer can't be looked up: its recent report is all there is.
    const host = typeof status?.host === "string" && status.host !== hostname() ? status.host : null;
    if (!host && (pid === process.pid || !pidAlive(pid))) continue;
    return { pid, host, standby: row.key !== "engine_status" };
  }
  return null;
}

export interface ApplyResult {
  applied: boolean;
  error?: string;
  replacedDir?: string;
  restore?: PendingRestore;
}

/** A new, empty folder: `base`, or `base-2`, `base-3`… when it exists (a rename into it must never replace a kept file). */
function newFolder(base: string): string {
  mkdirSync(path.dirname(base), { recursive: true });
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n >= 1000) throw err;
    }
  }
}

/**
 * Swaps in a restore that's waiting: the current database (with its -wal/-shm files), secret key (when the backup has
 * one) and folders move to DATA_DIR/backups/before-restore-<time>/, and the backup's take their place. If anything
 * fails, everything is put back and the reason is kept for the Backups page. Call it before the database is opened.
 */
export function applyPendingRestore(
  dataDir: string,
  opts: { log?: (line: string) => void; /** Tests replace this to make a move fail. */ move?: (from: string, to: string) => void } = {},
): ApplyResult {
  const log = opts.log ?? ((line: string) => console.log(line));
  const move = opts.move ?? moveSync;
  const pendingDir = path.join(dataDir, PENDING_DIR);
  const pending = readPendingRestore(dataDir);
  if (!pending) return { applied: false };
  const fail = (error: string): ApplyResult => {
    try {
      writeFileSync(path.join(pendingDir, ATTEMPT_FILE), JSON.stringify({ at: new Date().toISOString(), error }, null, 2));
    } catch {
      // the message is logged below either way
    }
    log(`[restore] ${error}`);
    return { applied: false, error, restore: pending };
  };
  if (!existsSync(path.join(pendingDir, "app.db"))) return fail("The waiting restore is incomplete (its database is missing). Cancel it and restore the backup again.");
  const other = liveEngineElsewhere(path.join(dataDir, "app.db"));
  if (other) {
    const which = `pid ${other.pid}${other.host ? ` on ${other.host}` : ""}`;
    return fail(
      other.standby
        ? `A second server or worker is still running on this data (${which}). Stop it, then restart the server to finish restoring.`
        : `The background engine is still running in another process (${which}). Stop it, then restart the server to finish restoring.`,
    );
  }

  let replacedDir: string;
  try {
    replacedDir = newFolder(path.join(dataDir, "backups", `before-restore-${fileStamp(new Date())}`));
  } catch (err) {
    return fail(`Couldn't finish restoring: ${(err as Error).message}. Nothing was changed.`);
  }
  const withSecret = existsSync(path.join(pendingDir, "secret.key"));
  const incoming = ["app.db", ...(withSecret ? ["secret.key"] : []), ...BACKUP_FOLDERS];
  const outgoing = ["app.db", "app.db-wal", "app.db-shm", "app.db-journal", ...(withSecret ? ["secret.key"] : []), ...BACKUP_FOLDERS];
  const movedOut: string[] = [];
  const movedIn: string[] = [];
  const created: string[] = [];
  try {
    for (const name of outgoing) {
      if (!existsSync(path.join(dataDir, name))) continue;
      move(path.join(dataDir, name), path.join(replacedDir, name));
      movedOut.push(name);
    }
    for (const name of incoming) {
      const from = path.join(pendingDir, name);
      if (existsSync(from)) {
        move(from, path.join(dataDir, name));
        movedIn.push(name);
      } else if ((BACKUP_FOLDERS as readonly string[]).includes(name)) {
        mkdirSync(path.join(dataDir, name), { recursive: true });
        created.push(name);
      }
    }
  } catch (err) {
    // Put everything back the way it was.
    for (const name of movedIn.reverse()) {
      try {
        moveSync(path.join(dataDir, name), path.join(pendingDir, name));
      } catch (e) {
        log(`[restore] Couldn't move ${name} back to ${pendingDir}: ${(e as Error).message}`);
      }
    }
    for (const name of created) {
      try {
        rmdirSync(path.join(dataDir, name));
      } catch {
        // not empty or gone: leave it
      }
    }
    for (const name of movedOut.reverse()) {
      try {
        moveSync(path.join(replacedDir, name), path.join(dataDir, name));
      } catch (e) {
        log(`[restore] Couldn't move ${name} back from ${replacedDir}: ${(e as Error).message}`);
      }
    }
    try {
      rmdirSync(replacedDir);
    } catch {
      // keep whatever couldn't be moved back
    }
    const code = (err as NodeJS.ErrnoException).code;
    const busy = code === "EBUSY" || code === "EPERM" || code === "EACCES";
    return fail(
      busy
        ? "Couldn't finish restoring: the data files are in use by another program. Make sure the server (and a separate worker, if you run one) is stopped, then start it again."
        : `Couldn't finish restoring: ${(err as Error).message}. Nothing was changed.`,
    );
  }

  const last: LastRestore = {
    restored_at: new Date().toISOString(),
    backup_created_at: pending.backup.created_at,
    source: pending.source,
    replaced_dir: replacedDir,
    pause_pending: true,
  };
  try {
    writeLastRestore(dataDir, last);
  } catch (err) {
    log(`[restore] Couldn't record the restore: ${(err as Error).message}`);
  }
  try {
    rmSync(pendingDir, { recursive: true, force: true });
  } catch {
    // only the request and manifest are left in it
  }
  log(`[restore] Restored the backup made ${pending.backup.created_at}. The data it replaced is in ${replacedDir}`);
  return { applied: true, replacedDir, restore: pending };
}

/**
 * Removes what checking or uploading a backup left in DATA_DIR when the app stopped part-way (as big as the backup),
 * and a backup `npm run restore` checked but wasn't told to restore. Only ones a day old, so none in use. Returns how many.
 */
export async function removeRestoreLeftovers(dataDir: string, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const name of await readdir(dataDir).catch(() => [] as string[])) {
    if (!name.startsWith(STAGING_PREFIX) && !name.startsWith(UPLOAD_PREFIX) && name !== COMMAND_DIR) continue;
    const full = path.join(dataDir, name);
    const st = await stat(full).catch(() => null);
    if (!st || now - st.mtimeMs < DAY) continue;
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}
