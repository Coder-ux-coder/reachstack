// Only one process may run the background engine against a database: two would send the same emails twice and answer
// the same warmup threads twice. The process running it holds a lease (the "engine_lease" app setting) and renews it
// every 15 seconds. A second server or worker started on the same data stands by and takes over when the lease runs
// out (a minute without renewal) or, on the same machine, as soon as the process holding it is gone.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, like, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { pidAlive } from "../services/backup-restore";

export const LEASE_KEY = "engine_lease";
export const LEASE_TTL_MS = 60_000;
export const LEASE_RENEW_MS = 15_000;

export interface EngineLease {
  token: string;
  pid: number;
  host: string;
  acquired_at: string;
  /** Epoch milliseconds; after this anyone may take the lease. */
  expires_at: number;
}

const S = schema.appSettings;
const token = randomUUID();
const host = hostname();
/** By this process's clock, the lease is ours until then: a renewal interval before it expires for everyone else. */
let validUntil = 0;
let claiming: Promise<boolean> | null = null;

export async function readLease(): Promise<EngineLease | null> {
  const [row] = await db.select({ value: S.value }).from(S).where(eq(S.key, LEASE_KEY)).limit(1);
  return (row?.value as EngineLease | undefined) ?? null;
}

/** Whether a lease stops this process from taking it: held by another process that's still renewing it. */
function heldElsewhere(lease: EngineLease, now: number): boolean {
  if (lease.token === token || lease.expires_at < now) return false;
  // On this machine a process that's gone can't renew, so there's no need to wait out the minute.
  return lease.host !== host || pidAlive(lease.pid);
}

async function claim(now: number): Promise<boolean> {
  const current = await readLease();
  if (current && heldElsewhere(current, now)) {
    validUntil = 0;
    return false;
  }
  const mine: EngineLease = {
    token,
    pid: process.pid,
    host,
    acquired_at: current?.token === token ? current.acquired_at : new Date(now).toISOString(),
    expires_at: now + LEASE_TTL_MS,
  };
  // Written only if the lease is still what was read: of two processes taking it at once, one gets it.
  const res = current
    ? await db
        .update(S)
        .set({ value: mine, updatedAt: new Date(now) })
        .where(and(eq(S.key, LEASE_KEY), sql`json_extract(${S.value}, '$.token') = ${current.token}`))
    : await db.insert(S).values({ key: LEASE_KEY, value: mine }).onConflictDoNothing();
  const won = res.rowsAffected === 1;
  validUntil = won ? now + LEASE_TTL_MS - LEASE_RENEW_MS : 0;
  return won;
}

/** Takes the lease when it's free, or renews it. True when this process holds it afterwards. */
export function claimLease(now = Date.now()): Promise<boolean> {
  claiming ??= claim(now).finally(() => {
    claiming = null;
  });
  return claiming;
}

/** Whether this process holds the lease now. */
export function holdsLease(now = Date.now()): boolean {
  return now < validUntil;
}

/** Gives the lease up (when the engine stops), so a process standing by takes over at once. */
export async function releaseLease() {
  validUntil = 0;
  await db.delete(S).where(and(eq(S.key, LEASE_KEY), sql`json_extract(${S.value}, '$.token') = ${token}`));
}

/** A process standing by notes it here, so a restore waits until it's stopped too (it has the database open). */
const STANDBY_KEY = `engine_standby:${token}`;

/** Renewed with every lease check while standing by; notes left by processes gone an hour are dropped. */
export async function noteStandby(now = Date.now()) {
  const value = { pid: process.pid, host, updated_at: new Date(now).toISOString() };
  await db
    .insert(S)
    .values({ key: STANDBY_KEY, value, updatedAt: new Date(now) })
    .onConflictDoUpdate({ target: S.key, set: { value, updatedAt: new Date(now) } });
  await db.delete(S).where(and(like(S.key, "engine_standby:%"), lt(S.updatedAt, new Date(now - 3_600_000))));
}

export async function clearStandby() {
  await db.delete(S).where(eq(S.key, STANDBY_KEY));
}

/** "process 1234 on this computer" / "process 1234 on host-b". */
export function describeHolder(lease: EngineLease | null): string {
  if (!lease) return "another process";
  return `process ${lease.pid} ${lease.host === host ? "on this computer" : `on ${lease.host}`}`;
}
