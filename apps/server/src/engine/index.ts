// Background engine: runs periodic loops (sending, inbox sync, warmup, webhooks, jobs, agents...). Only the process
// holding the engine lease runs them (./lease): another server or worker on the same data stands by.
import { hostname } from "node:os";
import { claimLease, clearStandby, describeHolder, holdsLease, LEASE_RENEW_MS, noteStandby, readLease, releaseLease } from "./lease";

type Loop = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  timer?: NodeJS.Timeout;
  running?: boolean;
  runs: number;
  failures: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastDurationMs?: number;
  lastError?: { at: number; message: string } | null;
};

/** What the engine reports about itself (stored as the "engine_status" app setting so the API can read it from any process). */
export interface EngineStatus {
  pid: number;
  host: string;
  started_at: string;
  updated_at: string;
  loops: Array<{
    name: string;
    interval_ms: number;
    running: boolean;
    runs: number;
    failures: number;
    last_started_at: string | null;
    last_finished_at: string | null;
    last_duration_ms: number | null;
    last_error: { at: string; message: string } | null;
  }>;
}

const loops: Loop[] = [];
let started = false;
let startedAt = 0;
let heartbeat: NodeJS.Timeout | undefined;
let leaseTimer: NodeJS.Timeout | undefined;
let standbyNoted = false;
let stopping = false;
const HEARTBEAT_MS = 30_000;
/** First passes start 2–5 seconds after the engine gets going, staggered so everything doesn't fire at once. */
export const engineTiming = { firstRunMs: 2_000, firstRunSpreadMs: 3_000 };

export function registerLoop(name: string, intervalMs: number, run: () => Promise<void>) {
  loops.push({ name, intervalMs, run, runs: 0, failures: 0 });
}

async function tick(loop: Loop) {
  if (loop.running || !holdsLease()) return;
  loop.running = true;
  loop.lastStartedAt = Date.now();
  try {
    await loop.run();
  } catch (err) {
    loop.failures++;
    loop.lastError = { at: Date.now(), message: (err as Error)?.message?.slice(0, 500) ?? String(err) };
    console.error(`[engine:${loop.name}]`, err);
  } finally {
    loop.running = false;
    loop.runs++;
    loop.lastFinishedAt = Date.now();
    loop.lastDurationMs = loop.lastFinishedAt - loop.lastStartedAt;
  }
}

const isoOrNull = (ms?: number) => (ms ? new Date(ms).toISOString() : null);

export function engineStatus(): EngineStatus {
  return {
    pid: process.pid,
    host: hostname(),
    started_at: new Date(startedAt).toISOString(),
    updated_at: new Date().toISOString(),
    loops: loops.map((l) => ({
      name: l.name,
      interval_ms: l.intervalMs,
      running: !!l.running,
      runs: l.runs,
      failures: l.failures,
      last_started_at: isoOrNull(l.lastStartedAt),
      last_finished_at: isoOrNull(l.lastFinishedAt),
      last_duration_ms: l.lastDurationMs ?? null,
      last_error: l.lastError ? { at: new Date(l.lastError.at).toISOString(), message: l.lastError.message } : null,
    })),
  };
}

async function writeHeartbeat() {
  if (!holdsLease()) return;
  try {
    const { setAppSetting } = await import("../services/instance");
    await setAppSetting("engine_status", engineStatus());
  } catch (err) {
    console.error("[engine] heartbeat failed", err);
  }
}

/** Whether the loops run in this process (it started the engine and holds the lease). */
export function engineRunsHere(): boolean {
  return started && holdsLease();
}

/**
 * Whether a pass in the middle of its work may carry on: not once the engine is stopping, or another process took the
 * lease over. Loops that send email check it between emails. (Tests run loops without starting the engine: they may.)
 */
export function keepSending(): boolean {
  return !stopping && (!started || holdsLease());
}

function firstRuns() {
  for (const loop of loops) setTimeout(() => void tick(loop), engineTiming.firstRunMs + Math.floor(Math.random() * engineTiming.firstRunSpreadMs));
  setTimeout(() => void writeHeartbeat(), engineTiming.firstRunMs + engineTiming.firstRunSpreadMs + 1_000);
}

/** Takes or renews the lease; on getting it, the loops start. Exported for tests (it runs every 15 seconds). */
export async function syncLease() {
  if (!started) return;
  const had = holdsLease();
  let has = false;
  try {
    has = await claimLease();
  } catch (err) {
    console.error("[engine] couldn't renew the engine lease", err);
    return;
  }
  if (!started) return;
  if (has && !had) {
    startedAt = Date.now();
    if (standbyNoted) await clearStandby().catch(() => undefined);
    standbyNoted = false;
    console.log(`  background engine: ${loops.length} loop${loops.length === 1 ? "" : "s"} running`);
    firstRuns();
  } else if (!has) {
    await noteStandby().catch((err) => console.error("[engine] couldn't note that this process is standing by", err));
    if (standbyNoted) return;
    standbyNoted = true;
    const holder = await readLease().catch(() => null);
    console.log(`  background engine: standing by, ${describeHolder(holder)} runs it (this one takes over if it stops)`);
  }
}

export function startEngine() {
  if (started) return;
  started = true;
  stopping = false;
  startedAt = 0;
  for (const loop of loops) loop.timer = setInterval(() => void tick(loop), loop.intervalMs);
  heartbeat = setInterval(() => void writeHeartbeat(), HEARTBEAT_MS);
  leaseTimer = setInterval(() => void syncLease(), LEASE_RENEW_MS);
  void syncLease();
}

/**
 * Stops the loops. Passes under way finish the step they're on (an email being sent goes out and is recorded) before
 * the lease is released, so a process that takes over doesn't send it again; after `waitMs` it lets go regardless.
 */
export async function stopEngine(waitMs = 15_000) {
  stopping = true;
  for (const loop of loops) if (loop.timer) clearInterval(loop.timer);
  if (heartbeat) clearInterval(heartbeat);
  if (leaseTimer) clearInterval(leaseTimer);
  const until = Date.now() + waitMs;
  while (loops.some((l) => l.running) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  const held = holdsLease();
  started = false;
  standbyNoted = false;
  if (held) await releaseLease().catch((err) => console.error("[engine] couldn't release the engine lease", err));
  else await clearStandby().catch(() => undefined);
}
