// Runs pending background jobs with the handler registered for their type.
import { and, asc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { HttpError } from "../http/errors";
import { MailError } from "../mail/types";
import { cleanUpJob, dropJobInput, jobHandler, loadJobInput, openJobSecret, withoutSecret, type JobContext } from "../services/jobs";

const J = schema.backgroundJobs;
const MAX_PARALLEL = 3;
/** A running job marks itself alive this often; one not marked for STALE_MS was running in a process that stopped. */
const HEARTBEAT_MS = 30_000;
const STALE_MS = 2 * 60_000;
/** A job that was cut short this many times (the app stopped while it ran) isn't started again. */
const MAX_ATTEMPTS = 3;
const running = new Set<string>();

/** Drops a job's input and sealed secret once it has run, whatever the outcome. */
async function wipeInput(jobId: string) {
  await dropJobInput(jobId);
  const [row] = await db.select({ data: J.data }).from(J).where(eq(J.id, jobId));
  if (row && openJobSecret(row) !== null) await db.update(J).set({ data: withoutSecret(row.data) }).where(eq(J.id, jobId));
}

/** Errors written for people (refusals, mail server answers, plain explanations) are shown; internals never are. */
const INTERNAL = /SQLITE_|libsql|constraint failed|is not a function|cannot read propert|is not defined|unexpected token|ECONN\w*|ETIMEDOUT|EACCES|EPERM|ENOENT/i;
export function jobErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (/SQLITE_FULL|ENOSPC/i.test(message)) return "The disk is full, so this couldn't finish. Free up some space, then try again.";
  const meant = err instanceof HttpError || err instanceof MailError || (err instanceof Error && err.constructor === Error && !INTERNAL.test(message));
  if (meant && message.trim()) return message.slice(0, 1000);
  return "Something went wrong on the server while this ran. Try again; if it keeps happening, the server log has the details.";
}

async function runJob(jobId: string) {
  running.add(jobId);
  let beat: ReturnType<typeof setInterval> | undefined;
  try {
    const [claimed] = await db
      .update(J)
      .set({ status: "in-progress", lockedAt: new Date() })
      .where(and(eq(J.id, jobId), eq(J.status, "pending")))
      .returning();
    if (!claimed) return;
    const handler = jobHandler(claimed.type);
    if (!handler) {
      await db.update(J).set({ status: "failed", error: `No handler for job type ${claimed.type}` }).where(eq(J.id, jobId));
      await wipeInput(jobId);
      return;
    }
    // Alive while it runs, even through a long step that reports no progress.
    beat = setInterval(() => {
      void db
        .update(J)
        .set({ lockedAt: new Date() })
        .where(and(eq(J.id, jobId), eq(J.status, "in-progress")))
        .catch(() => {});
    }, HEARTBEAT_MS);
    const stored = await loadJobInput(claimed);
    let lastWrite = 0;
    const ctx: JobContext = {
      job: claimed,
      input: <T,>() => (stored.input ?? null) as T | null,
      secret: <T,>() => (stored.secret ?? null) as T | null,
      async progress(pct, data) {
        const now = Date.now();
        if (now - lastWrite < 750 && pct < 100) return;
        lastWrite = now;
        await db
          .update(J)
          .set({ progress: Math.max(0, Math.min(100, pct)), lockedAt: new Date(), ...(data ? { data: { ...withoutSecret(claimed.data), ...data } } : {}) })
          .where(eq(J.id, jobId));
      },
      async cancelled() {
        const [row] = await db.select({ status: J.status }).from(J).where(eq(J.id, jobId));
        return row?.status === "cancelled";
      },
    };
    try {
      const result = await handler(ctx);
      const [now] = await db.select({ status: J.status }).from(J).where(eq(J.id, jobId));
      // A stopped job keeps what it did before it stopped.
      if (now?.status === "cancelled") {
        await db.update(J).set({ result: result ?? null, lockedAt: null }).where(eq(J.id, jobId));
        return;
      }
      await db
        .update(J)
        .set({ status: "success", progress: 100, result: result ?? null, lockedAt: null })
        .where(eq(J.id, jobId));
    } catch (err) {
      console.error(`[job:${claimed.type}]`, err);
      await db
        .update(J)
        .set({ status: "failed", error: jobErrorMessage(err), lockedAt: null, attempts: claimed.attempts + 1 })
        .where(eq(J.id, jobId));
    } finally {
      await wipeInput(jobId);
      await cleanUpJob(claimed, { handlerRan: true });
    }
  } finally {
    if (beat) clearInterval(beat);
    running.delete(jobId);
  }
}

/**
 * Jobs left "in progress" by a process that stopped (a restart, a crash) go back in the queue, unless they were already
 * cut short MAX_ATTEMPTS times: those fail with a note saying so.
 */
export async function requeueStalledJobs(now = Date.now()) {
  const stalled = and(eq(J.status, "in-progress"), lt(J.lockedAt, new Date(now - STALE_MS)), running.size ? notInArray(J.id, [...running]) : undefined);
  const given = await db
    .update(J)
    .set({ status: "failed", lockedAt: null, error: "The app stopped while this was running, several times, so it wasn't started again. Start it again to retry." })
    .where(and(stalled, sql`${J.attempts} + 1 >= ${MAX_ATTEMPTS}`))
    .returning();
  for (const g of given) {
    await wipeInput(g.id);
    await cleanUpJob(g, { handlerRan: false });
  }
  await db
    .update(J)
    .set({ status: "pending", lockedAt: null, attempts: sql`${J.attempts} + 1` })
    .where(stalled);
}

let lastSweep = 0;

export async function runPendingJobs() {
  if (Date.now() - lastSweep > HEARTBEAT_MS) {
    lastSweep = Date.now();
    await requeueStalledJobs();
  }
  if (running.size >= MAX_PARALLEL) return;
  const pending = await db
    .select({ id: J.id })
    .from(J)
    .where(inArray(J.status, ["pending"]))
    .orderBy(asc(J.createdAt))
    .limit(MAX_PARALLEL - running.size);
  for (const p of pending) {
    if (running.has(p.id)) continue;
    void runJob(p.id);
  }
}
