// Backups of the whole installation (Settings → Installation → Backups): a consistent copy of the database taken while
// the app keeps running, the secret key, and the attachments and uploads folders, in one .tar.gz in DATA_DIR/backups.
// Made by hand, or on the owner's schedule by the "backups" engine loop (engine/backups.ts). The archive format lives in
// ./backup-archive and restoring in ./backup-restore. A lock file keeps the API and a separate worker from making two
// at once; the outcome of the last run is kept in the app setting "backup_state".
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import { CampaignStatus, EmailType, type BackupSchedule } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config, REPO_ROOT } from "../env";
import { conflict, HttpError } from "../http/errors";
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, listFiles, secretFingerprint, sqliteTask, writeTarGz, fileSha256, type BackupManifest, type FileItem, type TarSource } from "./backup-archive";
import { BACKUP_FOLDERS, fileStamp, formatBytes, freeBytes, pidAlive, readLastRestore, readPendingRestore, writeLastRestore, type LastRestore } from "./backup-restore";
import { getAppSetting, setAppSetting } from "./instance";
import { getInstallationSettings, updateInstallationSettings } from "./installation";
import { notify } from "./notifications";
import { canRestart } from "./restart";
import { workspaceZones } from "./workspace-clock";

export type BackupKind = "manual" | "automatic";

export interface BackupFile {
  /** The file name, which is also the id in URLs. */
  id: string;
  created_at: string;
  kind: BackupKind;
  bytes: number;
}

interface BackupRun {
  at: string;
  kind: BackupKind;
  ok: boolean;
  id?: string;
  bytes?: number;
  duration_ms: number;
  error?: string;
}

interface BackupState {
  /** When the owner last changed when automatic backups run (only slots after it count). */
  schedule_changed_at?: string | null;
  last_automatic_at?: string | null;
  /** A failed automatic backup is tried again after RETRY_MS, not every minute. */
  last_failed_attempt_at?: string | null;
  last?: BackupRun | null;
}

interface Lock {
  pid: number;
  kind: BackupKind;
  started_at: string;
}

const STATE_KEY = "backup_state";
const RETRY_MS = 30 * 60_000;
const LOCK_MAX_AGE_MS = 12 * 3_600_000;
const NAME = /^backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-(manual|automatic)(?:-(\d{1,3}))?\.tar\.gz$/;

export const backupsDir = () => path.join(config.dataDir, "backups");
const lockFile = () => path.join(backupsDir(), ".lock");

let version: string | null = null;
function appVersion(): string {
  if (version) return version;
  try {
    version = (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    version = "unknown";
  }
  return version;
}

// ---------- Files ----------

function parseName(id: string): Omit<BackupFile, "bytes"> | null {
  const m = NAME.exec(id);
  if (!m) return null;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(at) ? null : { id, created_at: new Date(at).toISOString(), kind: m[7] as BackupKind };
}

/** The archive's path for an id from a URL, or null for anything that isn't one of our backup names. */
export function backupPath(id: string): string | null {
  return parseName(id) && path.basename(id) === id ? path.join(backupsDir(), id) : null;
}

export async function listBackups(): Promise<BackupFile[]> {
  let names: string[];
  try {
    names = await readdir(backupsDir());
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    const info = parseName(name);
    if (!info) continue;
    try {
      const st = await stat(path.join(backupsDir(), name));
      if (st.isFile()) out.push({ ...info, bytes: st.size });
    } catch {
      // deleted while we looked
    }
  }
  return out.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
}

export async function deleteBackup(id: string): Promise<boolean> {
  const file = backupPath(id);
  if (!file || !existsSync(file)) return false;
  await rm(file, { force: true });
  return true;
}

/** The download name: the product's name first, so the file says what it is. */
export function downloadName(id: string): string {
  const brand = config.brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
  return `${brand}-${id}`;
}

// ---------- Lock and state ----------

let runningHere: Lock | null = null;

function readLock(): Lock | null {
  try {
    return JSON.parse(readFileSync(lockFile(), "utf8")) as Lock;
  } catch {
    return null;
  }
}

/** The backup being made right now, by this process or another one (a separate worker), if any. */
export function runningBackup(): Lock | null {
  if (runningHere) return runningHere;
  const lock = readLock();
  if (!lock || lock.pid === process.pid) return null;
  return pidAlive(lock.pid) && Date.now() - Date.parse(lock.started_at) < LOCK_MAX_AGE_MS ? lock : null;
}

const busy = () => conflict("A backup is being made right now. Try again when it's finished.");

async function takeLock(kind: BackupKind): Promise<Lock> {
  await mkdir(backupsDir(), { recursive: true });
  // Whole seconds, so the file name and the manifest show the same time.
  const lock: Lock = { pid: process.pid, kind, started_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockFile(), JSON.stringify(lock), { flag: "wx" });
      runningHere = lock;
      return lock;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (runningBackup()) throw busy();
      // Left by a process that stopped mid-backup.
      await rm(lockFile(), { force: true });
    }
  }
  throw busy();
}

async function releaseLock(lock: Lock) {
  if (runningHere === lock) runningHere = null;
  const current = readLock();
  if (current && current.pid === lock.pid && current.started_at === lock.started_at) await rm(lockFile(), { force: true });
}

async function readState(): Promise<BackupState> {
  return (await getAppSetting<BackupState | null>(STATE_KEY, null)) ?? {};
}

async function saveState(patch: Partial<BackupState>) {
  await setAppSetting(STATE_KEY, { ...(await readState()), ...patch });
}

// ---------- Making a backup ----------

const errorText = (err: unknown) => ((err as Error)?.message || String(err)).slice(0, 500);

function sizeOf(file: string): Promise<number> {
  return stat(file).then(
    (s) => s.size,
    () => 0,
  );
}

/** Work folders and unfinished archives left by a run that stopped (only called while holding the lock). */
async function removeLeftovers(dir: string) {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith(".work-") || name.endsWith(".partial")) await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

const listFolders = async (): Promise<Record<string, FileItem[]>> =>
  Object.fromEntries(await Promise.all(BACKUP_FOLDERS.map(async (f) => [f, await listFiles(path.join(config.dataDir, f))] as const)));
const bytesIn = (list: FileItem[]) => list.reduce((n, f) => n + f.size, 0);

async function makeBackup(kind: BackupKind, at: Date): Promise<BackupFile> {
  const dir = backupsDir();
  await removeLeftovers(dir);
  const folderBytes = Object.values(await listFolders()).reduce((n, list) => n + bytesIn(list), 0);
  const dbBytes = (await sizeOf(config.dbFile)) + (await sizeOf(`${config.dbFile}-wal`));
  // Room for the database copy and the archive (never bigger than what goes in it).
  const needed = dbBytes * 2 + folderBytes + 64 * 1024 * 1024;
  const free = await freeBytes(dir);
  if (free !== null && free < needed) {
    throw new HttpError(507, `There isn't enough free disk space for a backup: it needs about ${formatBytes(needed)} and ${formatBytes(free)} is free.`, "insufficient_storage");
  }

  let id = `backup-${fileStamp(at)}-${kind}.tar.gz`;
  for (let n = 2; existsSync(path.join(dir, id)); n++) id = `backup-${fileStamp(at)}-${kind}-${n}.tar.gz`;
  const work = await mkdtemp(path.join(dir, ".work-"));
  const partial = path.join(dir, `.${id}.partial`);
  try {
    if (!existsSync(config.dbFile)) throw new Error("The database file is missing");
    const snapshot = path.join(work, "app.db");
    const copy = await sqliteTask({ op: "snapshot", src: config.dbFile, out: snapshot });
    // Listed after the copy, so a file attached while it was made isn't left out of the backup.
    const folders = await listFolders();
    const secretFile = path.join(config.dataDir, "secret.key");
    const withSecret = existsSync(secretFile);
    const fromEnv = (process.env.APP_SECRET ?? "").length >= 32;
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      format_version: BACKUP_FORMAT_VERSION,
      app: { name: config.brandName, version: appVersion() },
      created_at: at.toISOString(),
      kind,
      database: { file: "app.db", bytes: await sizeOf(snapshot), sha256: await fileSha256(snapshot), migration_at: copy.migration_at, counts: copy.counts },
      secret_key: { included: withSecret, source: fromEnv ? "environment" : "file", fingerprint: secretFingerprint(config.secret) },
      folders: Object.fromEntries(Object.entries(folders).map(([f, list]) => [f, { files: list.length, bytes: bytesIn(list) }])),
      server: { node: process.version, platform: `${process.platform} ${process.arch}`, time_zone: DateTime.local().zoneName },
    };
    const entries: TarSource[] = [
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: at },
      { name: "app.db", file: snapshot },
      ...(withSecret ? [{ name: "secret.key", file: secretFile }] : []),
      ...Object.entries(folders).flatMap(([f, list]) => list.map((x) => ({ name: `${f}/${x.rel}`, file: x.abs }))),
    ];
    await writeTarGz(partial, entries);
    await rename(partial, path.join(dir, id));
    return { id, created_at: at.toISOString(), kind, bytes: await sizeOf(path.join(dir, id)) };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

async function pruneAutomatic() {
  const { keep } = (await getInstallationSettings()).backups;
  const automatic = (await listBackups()).filter((b) => b.kind === "automatic");
  for (const b of automatic.slice(keep)) await rm(path.join(backupsDir(), b.id), { force: true }).catch(() => undefined);
}

async function runLocked(lock: Lock): Promise<BackupFile> {
  const started = Date.now();
  try {
    const file = await makeBackup(lock.kind, new Date(lock.started_at));
    const run: BackupRun = { at: file.created_at, kind: lock.kind, ok: true, id: file.id, bytes: file.bytes, duration_ms: Date.now() - started };
    await saveState({ last: run, ...(lock.kind === "automatic" ? { last_automatic_at: file.created_at, last_failed_attempt_at: null } : {}) });
    if (lock.kind === "automatic") await pruneAutomatic();
    return file;
  } catch (err) {
    const now = new Date().toISOString();
    const run: BackupRun = { at: now, kind: lock.kind, ok: false, duration_ms: Date.now() - started, error: errorText(err) };
    await saveState({ last: run, ...(lock.kind === "automatic" ? { last_failed_attempt_at: now } : {}) }).catch(() => undefined);
    throw err;
  } finally {
    await releaseLock(lock);
  }
}

/** Makes a backup and waits for it. A 409 when another one is being made. */
export async function createBackup(kind: BackupKind): Promise<BackupFile> {
  return runLocked(await takeLock(kind));
}

/** Starts a backup and answers at once ("Back up now"); its outcome shows in backupOverview().last. */
export async function startBackup(kind: BackupKind): Promise<{ kind: BackupKind; started_at: string }> {
  const lock = await takeLock(kind);
  void runLocked(lock).catch((err) => console.error("[backups] backup failed:", errorText(err)));
  return { kind, started_at: lock.started_at };
}

// ---------- Schedule ----------

/** The latest scheduled time at or before `now`, in the server's time zone; null when automatic backups are off. */
export function lastSlot(s: BackupSchedule, now: DateTime): DateTime | null {
  if (s.frequency === "off") return null;
  let slot = now.set({ hour: s.hour, minute: 0, second: 0, millisecond: 0 });
  if (s.frequency === "weekly") slot = slot.minus({ days: (now.weekday - s.weekday + 7) % 7 });
  if (slot > now) slot = s.frequency === "daily" ? slot.minus({ days: 1 }) : slot.minus({ weeks: 1 });
  return slot;
}

export function nextSlot(s: BackupSchedule, now: DateTime): DateTime | null {
  const last = lastSlot(s, now);
  if (!last) return null;
  return s.frequency === "daily" ? last.plus({ days: 1 }) : last.plus({ weeks: 1 });
}

const ms = (v: string | null | undefined) => (v ? Date.parse(v) || 0 : 0);

/**
 * Whether an automatic backup should be made now: a scheduled time has passed since the last automatic backup and since
 * the schedule was last changed (so turning it on doesn't start one at once), and the last attempt didn't just fail.
 * A time missed while the server was down is caught up once.
 */
export function automaticBackupDue(s: BackupSchedule, state: BackupState, now: DateTime, newestAutomaticAt: string | null): boolean {
  const slot = lastSlot(s, now);
  if (!slot) return false;
  const done = Math.max(ms(state.last_automatic_at), ms(state.schedule_changed_at), ms(newestAutomaticAt));
  if (slot.toMillis() <= done) return false;
  return now.toMillis() - ms(state.last_failed_attempt_at) >= RETRY_MS;
}

/** The engine loop: makes the automatic backup when it's due. Failures are thrown so the loop records them. */
export async function runScheduledBackup(): Promise<void> {
  const schedule = (await getInstallationSettings()).backups;
  if (schedule.frequency === "off" || runningBackup()) return;
  const newest = (await listBackups()).find((b) => b.kind === "automatic")?.created_at ?? null;
  if (!automaticBackupDue(schedule, await readState(), DateTime.now(), newest)) return;
  try {
    await createBackup("automatic");
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 409) return; // someone started one by hand meanwhile
    throw err;
  }
}

export async function setBackupSchedule(patch: Partial<BackupSchedule>): Promise<BackupSchedule> {
  const before = (await getInstallationSettings()).backups;
  const next = (await updateInstallationSettings({ backups: patch })).backups;
  const timingChanged = next.frequency !== before.frequency || next.hour !== before.hour || (next.frequency === "weekly" && next.weekday !== before.weekday);
  if (timingChanged) await saveState({ schedule_changed_at: new Date().toISOString(), last_failed_attempt_at: null });
  return next;
}

// ---------- After a restore ----------

const HELD_AFTER_RESTORE =
  "Held after the restore from a backup: it was due before the restore, so it may have gone out already. Check the mailbox's Sent folder, then send it again or delete it.";

/**
 * The first start after a restore pauses every campaign that was sending and holds the scheduled emails that were due:
 * what was sent after the backup was made isn't in the restored data, so carrying on could send it a second time. Each
 * workspace with any is told, and the Backups page says what was paused. Runs before the engine starts (server and worker).
 */
export async function pauseSendingAfterRestore(): Promise<LastRestore["paused"] | null> {
  const last = readLastRestore(config.dataDir);
  if (!last?.pause_pending) return null;
  const C = schema.campaigns;
  const M = schema.emails;
  const campaigns = await db
    .update(C)
    .set({ status: CampaignStatus.PAUSED, notSendingStatus: null })
    .where(inArray(C.status, [CampaignStatus.ACTIVE, CampaignStatus.RUNNING_SUBSEQUENCES, CampaignStatus.ACCOUNTS_UNHEALTHY]))
    .returning({ workspaceId: C.workspaceId });
  const emails = await db
    .update(M)
    .set({ scheduledAt: null, sendError: HELD_AFTER_RESTORE })
    .where(and(eq(M.ueType, EmailType.SCHEDULED), isNotNull(M.scheduledAt), lte(M.scheduledAt, new Date(last.restored_at)), isNull(M.deletedAt)))
    .returning({ workspaceId: M.workspaceId });
  // Read again: a worker starting at the same moment may have paused some of them.
  const { pause_pending: _, ...now } = readLastRestore(config.dataDir) ?? last;
  const paused = { campaigns: (now.paused?.campaigns ?? 0) + campaigns.length, scheduled_emails: (now.paused?.scheduled_emails ?? 0) + emails.length };
  try {
    writeLastRestore(config.dataDir, { ...now, paused });
  } catch (err) {
    console.error("[restore] couldn't record what was paused:", errorText(err));
  }
  if (campaigns.length || emails.length) console.log(`[restore] Paused ${campaigns.length} campaign(s) that were sending and held ${emails.length} scheduled email(s) that were due.`);

  const perWorkspace = new Map<string, { campaigns: number; emails: number }>();
  for (const r of campaigns) perWorkspace.set(r.workspaceId, { campaigns: (perWorkspace.get(r.workspaceId)?.campaigns ?? 0) + 1, emails: perWorkspace.get(r.workspaceId)?.emails ?? 0 });
  for (const r of emails) perWorkspace.set(r.workspaceId, { campaigns: perWorkspace.get(r.workspaceId)?.campaigns ?? 0, emails: (perWorkspace.get(r.workspaceId)?.emails ?? 0) + 1 });
  const zones = await workspaceZones([...perWorkspace.keys()]);
  for (const [workspaceId, n] of perWorkspace) {
    const made = DateTime.fromISO(last.backup_created_at).setZone(zones.get(workspaceId) ?? "UTC").toFormat("LLL d 'at' h:mm a");
    const what = [
      n.campaigns ? `${n.campaigns} campaign${n.campaigns === 1 ? " that was sending is" : "s that were sending are"} paused` : null,
      n.emails ? `${n.emails} scheduled email${n.emails === 1 ? " that was due is" : "s that were due are"} held` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    await notify({
      workspaceId,
      type: "sending_paused",
      title: "Sending paused after a restore",
      body: `This installation was restored from a backup made ${made}, which doesn't have what was sent after that. So nothing goes out twice, ${what}. Check the mailboxes' Sent folders for what went out since, then resume ${n.campaigns + n.emails === 1 ? "it" : "them"}.`,
      link: n.campaigns ? "/app/campaigns?status=paused" : "/app/unibox?folder=scheduled",
      perm: n.campaigns ? "view_campaigns" : "unibox",
      staffOnly: true,
    }).catch((err) => console.error("[restore] couldn't send the notification:", errorText(err)));
  }
  return paused;
}

// ---------- What the Backups page shows ----------

export async function backupOverview() {
  const [backups, settings, state] = await Promise.all([listBackups(), getInstallationSettings(), readState()]);
  const now = DateTime.now();
  const running = runningBackup();
  const newest = backups.find((b) => b.kind === "automatic")?.created_at ?? null;
  const due = automaticBackupDue(settings.backups, state, now, newest);
  const next = settings.backups.frequency === "off" ? null : due ? now : nextSlot(settings.backups, now);
  return {
    backups,
    running: running ? { kind: running.kind, started_at: running.started_at } : null,
    last: state.last ?? null,
    schedule: settings.backups,
    next_automatic_at: next ? next.toUTC().toISO() : null,
    /** Automatic backups run on the server's clock. */
    time_zone: now.zoneName ?? "UTC",
    storage: {
      backups_dir: backupsDir(),
      data_dir: config.dataDir,
      free_bytes: await freeBytes(existsSync(backupsDir()) ? backupsDir() : config.dataDir),
      backups_bytes: backups.reduce((n, b) => n + b.bytes, 0),
    },
    secret_key: { source: (process.env.APP_SECRET ?? "").length >= 32 ? ("environment" as const) : ("file" as const) },
    worker_in_process: config.runWorkerInProcess,
    can_restart: canRestart(),
    pending_restore: readPendingRestore(config.dataDir),
    last_restore: readLastRestore(config.dataDir),
  };
}

