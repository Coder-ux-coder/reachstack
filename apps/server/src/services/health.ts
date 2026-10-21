// System health for the installation's owner and administrators (Settings → Installation → Health): whether the
// background engine's loops run on time, how far behind inbox sync is per mailbox, the job queue, campaigns that
// stopped sending, and how much room the database and the data folder take on the disk.
import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { CampaignStatus, NOT_SENDING_NEEDS_ATTENTION } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { engineRunsHere, engineStatus, type EngineStatus } from "../engine";
import { syncIntervalMs } from "../engine/inbox-sync";
import { config } from "../env";
import { iso } from "../lib/time";
import { getAppSetting } from "./instance";
import { stoppedWorkspaces } from "./live-workspaces";

export type Tone = "ok" | "warn" | "bad";

const MIN = 60_000;
const worst = (...tones: Tone[]): Tone => (tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : "ok");

// ---------- Engine ----------

/** The loops that matter most for sending and replies; the summary looks at these. */
export const KEY_LOOPS = ["sender", "inbox-sync", "warmup", "jobs"] as const;

type LoopState = "ok" | "starting" | "late" | "stuck" | "failing";

function loopHealth(l: EngineStatus["loops"][number], now: number) {
  const finished = l.last_finished_at ? Date.parse(l.last_finished_at) : null;
  const started = l.last_started_at ? Date.parse(l.last_started_at) : null;
  // Late: no finished pass for three intervals (at least 2 minutes). Stuck: one pass running for ten (at least 10 minutes).
  // Failing: its latest pass ended in an error (the engine keeps the last error after later passes work).
  const lateAfter = Math.max(3 * l.interval_ms, 2 * MIN);
  const stuckAfter = Math.max(10 * l.interval_ms, 10 * MIN);
  let state: LoopState = "ok";
  if (l.running && started !== null && now - started > stuckAfter) state = "stuck";
  else if (!l.running && l.last_error && started !== null && Date.parse(l.last_error.at) >= started) state = "failing";
  else if (finished === null) state = "starting";
  else if (!l.running && now - finished > lateAfter) state = "late";
  return {
    name: l.name,
    interval_ms: l.interval_ms,
    running: l.running,
    runs: l.runs,
    failures: l.failures,
    last_run_at: l.last_finished_at,
    last_duration_ms: l.last_duration_ms,
    last_error: l.last_error,
    state,
    late_after_ms: lateAfter,
  };
}

async function engineHealth(now: number) {
  // The engine in this process knows its state now; one in another process (a separate worker, or another server on
  // the same data holding the engine lease) reports through the "engine_status" setting.
  const engine = engineRunsHere() ? engineStatus() : await getAppSetting<EngineStatus | null>("engine_status", null);
  // The engine writes its status every 30 seconds; two minutes without one means it isn't running.
  const reportedAt = engine ? Date.parse(engine.updated_at) : null;
  const reporting = reportedAt !== null && now - reportedAt < 2 * MIN;
  const loops = (engine?.loops ?? []).map((l) => loopHealth(l, now));
  const key = loops.filter((l) => (KEY_LOOPS as readonly string[]).includes(l.name));
  const tone: Tone = !reporting ? "bad" : worst(...key.map((l): Tone => (l.state === "stuck" || l.state === "failing" ? "bad" : l.state === "late" ? "warn" : "ok")), loops.some((l) => l.state !== "ok" && l.state !== "starting") ? "warn" : "ok");
  return { tone, reporting, reported_at: engine?.updated_at ?? null, started_at: engine?.started_at ?? null, in_process: config.runWorkerInProcess, loops };
}

// ---------- Inbox sync ----------

async function inboxSyncHealth(now: number) {
  const A = schema.emailAccounts;
  // The mailboxes inbox sync checks (not those of deleted workspaces or turned-off accounts), each at its own pace.
  const stopped = await stoppedWorkspaces();
  const rows = await db
    .select({
      email: A.email,
      status: A.status,
      statusMessage: A.statusMessage,
      consecutiveErrors: A.consecutiveErrors,
      providerCode: A.providerCode,
      lastSyncAt: A.lastSyncAt,
      createdAt: A.createdAt,
      workspaceId: A.workspaceId,
      workspace: schema.workspaces.name,
    })
    .from(A)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, A.workspaceId))
    .where(and(eq(A.setupPending, false), isNull(schema.workspaces.deletedAt)));
  const items = rows
    .filter((a) => !stopped.has(a.workspaceId))
    .map((a) => {
      const since = (a.lastSyncAt ?? a.createdAt).getTime();
      const lag = Math.max(0, now - since);
      // Late: five missed checks, and at least five minutes behind.
      const late = lag > Math.max(5 * syncIntervalMs(a), 5 * MIN);
      return { email: a.email, workspace_id: a.workspaceId, workspace: a.workspace, status: a.status, last_sync_at: iso(a.lastSyncAt), lag_s: Math.round(lag / 1000), late };
    })
    .sort((a, b) => b.lag_s - a.lag_s);
  const late = items.filter((i) => i.late);
  const errors = items.filter((i) => i.status < 0).length;
  return {
    tone: (late.length ? "warn" : "ok") as Tone,
    mailboxes: items.length,
    late: late.length,
    errors,
    oldest_sync_at: items[0]?.last_sync_at ?? null,
    oldest_lag_s: items[0]?.lag_s ?? 0,
    items: items.slice(0, 50),
  };
}

// ---------- Background jobs ----------

async function jobsHealth(now: number) {
  const J = schema.backgroundJobs;
  const dayAgo = new Date(now - 24 * 60 * MIN);
  const counts = await db
    .select({ status: J.status, n: sql<number>`count(*)`, oldest: sql<number | null>`min(${J.createdAt})` })
    .from(J)
    .where(or(inArray(J.status, ["pending", "in-progress"]), and(eq(J.status, "failed"), gte(J.updatedAt, dayAgo))))
    .groupBy(J.status);
  const by = new Map(counts.map((c) => [c.status, c]));
  // A job that holds its lock for half an hour without reporting progress is stuck (the server may have restarted).
  const [stuck] = await db
    .select({ n: sql<number>`count(*)` })
    .from(J)
    .where(and(eq(J.status, "in-progress"), lt(J.lockedAt, new Date(now - 30 * MIN))));
  const pending = Number(by.get("pending")?.n ?? 0);
  const oldestPending = by.get("pending")?.oldest ? Number(by.get("pending")!.oldest) : null;
  const waitingLong = oldestPending !== null && now - oldestPending > 15 * MIN;
  const failed = Number(by.get("failed")?.n ?? 0);
  const stuckN = Number(stuck?.n ?? 0);
  return {
    tone: (stuckN || waitingLong ? "bad" : failed ? "warn" : "ok") as Tone,
    pending,
    running: Number(by.get("in-progress")?.n ?? 0),
    failed_24h: failed,
    stuck: stuckN,
    oldest_pending_at: iso(oldestPending),
  };
}

// ---------- Campaigns ----------

async function campaignHealth() {
  const C = schema.campaigns;
  const rows = await db
    .select({ id: C.id, name: C.name, status: C.status, reason: C.notSendingStatus, workspaceId: C.workspaceId, workspace: schema.workspaces.name })
    .from(C)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, C.workspaceId))
    .where(and(inArray(C.status, [CampaignStatus.ACTIVE, CampaignStatus.ACCOUNTS_UNHEALTHY]), isNull(schema.workspaces.deletedAt)))
    .orderBy(asc(C.name));
  const attention = rows.filter((c) => c.status === CampaignStatus.ACCOUNTS_UNHEALTHY || (c.reason !== null && NOT_SENDING_NEEDS_ATTENTION.has(c.reason)));
  return {
    tone: (attention.length ? "warn" : "ok") as Tone,
    running: rows.length,
    needs_attention: attention.length,
    items: attention.slice(0, 20).map((c) => ({ id: c.id, name: c.name, workspace_id: c.workspaceId, workspace: c.workspace, status: c.status, not_sending_status: c.reason })),
  };
}

// ---------- Storage ----------

const fileSize = async (file: string) => {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
};

/** Walking the data folder can take a moment with many attachments, so its size is kept for ten minutes. */
let folderCache: { at: number; bytes: number; files: number; partial: boolean } | null = null;
let folderWalk: Promise<void> | null = null;
const MAX_ENTRIES = 200_000;

async function measureFolder(root: string) {
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length && seen < MAX_ENTRIES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        bytes += await fileSize(full);
        files++;
      }
    }
  }
  folderCache = { at: Date.now(), bytes, files, partial: seen >= MAX_ENTRIES };
}

async function folderSize() {
  const stale = !folderCache || Date.now() - folderCache.at > 10 * MIN;
  if (stale && !folderWalk) folderWalk = measureFolder(config.dataDir).finally(() => (folderWalk = null));
  if (!folderCache && folderWalk) await folderWalk;
  return folderCache!;
}

async function storageHealth() {
  const database = (await fileSize(config.dbFile)) + (await fileSize(`${config.dbFile}-wal`)) + (await fileSize(`${config.dbFile}-shm`));
  const folder = await folderSize();
  let free: number | null = null;
  let total: number | null = null;
  try {
    const s = await statfs(config.dataDir);
    free = Number(s.bavail) * Number(s.bsize);
    total = Number(s.blocks) * Number(s.bsize);
  } catch {
    // Not available on this system; the sizes still show.
  }
  const GB = 1024 ** 3;
  const share = free !== null && total ? free / total : null;
  const tone: Tone = free === null ? "ok" : free < GB || (share !== null && share < 0.05) ? "bad" : free < 5 * GB || (share !== null && share < 0.1) ? "warn" : "ok";
  return {
    tone,
    data_dir: config.dataDir,
    database_bytes: database,
    data_dir_bytes: folder.bytes,
    data_dir_files: folder.files,
    data_dir_partial: folder.partial,
    data_dir_measured_at: iso(folder.at),
    disk_free_bytes: free,
    disk_total_bytes: total,
  };
}

// ---------- All together ----------

export async function systemHealth(now = Date.now()) {
  const [engine, inboxSync, jobs, campaigns, storage] = await Promise.all([engineHealth(now), inboxSyncHealth(now), jobsHealth(now), campaignHealth(), storageHealth()]);
  return {
    checked_at: iso(now),
    status: worst(engine.tone, inboxSync.tone, jobs.tone, campaigns.tone, storage.tone),
    engine,
    inbox_sync: inboxSync,
    jobs,
    campaigns,
    storage,
  };
}
