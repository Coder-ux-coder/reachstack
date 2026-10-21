// Background jobs: long-running work (imports, exports, bulk moves, verification, enrichment...).
// Jobs are rows in background_jobs; the engine picks pending jobs and runs the registered handler.
import { and, eq } from "drizzle-orm";
import type { Permission } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { decryptJson, encryptJson } from "../lib/crypto";
import { uuidv7 } from "../lib/ids";
import { iso } from "../lib/time";

export type JobRow = typeof schema.backgroundJobs.$inferSelect;

export interface JobContext {
  job: JobRow;
  /** The `input` given to createJob, or null. */
  input<T>(): T | null;
  /** The `secret` given to createJob (decrypted), or null. */
  secret<T>(): T | null;
  /** Report progress 0–100 (throttled writes). */
  progress(pct: number, data?: Record<string, unknown>): Promise<void>;
  /** True when the job was cancelled from the UI/API. */
  cancelled(): Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export function jobHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

/** Job types something runs. */
export const jobTypes = () => [...handlers.keys()];

/**
 * What starting a job of each type takes, and so what seeing one takes for someone who didn't start it: a job's data
 * can name leads or files. "admin" (and a type not listed) is for owners and admins only.
 */
export const JOB_PERMISSIONS: Record<string, Permission | "admin"> = {
  "import-leads": "leads",
  "move-leads": "leads",
  "edit-leads": "leads",
  "export-leads": "leads",
  "delete-leads": "leads",
  "delete-variable": "leads",
  "rename-variable": "leads",
  "verify-leads": "leads",
  "verify-emails": "leads",
  "enrich-leads": "leads",
  "import-accounts": "accounts",
  "update-warmup-accounts": "accounts",
  "lead-finder-import": "lead_finder",
  "company-list-build": "lead_finder",
  "lf-export": "lead_finder",
  "lf-dataset-import": "lead_finder",
  "lf-demo-dataset": "lead_finder",
  "workspace-export": "admin",
};

/** `handlerRan`: the handler ran to its end (finished, failed or stopped) and had its chance to tidy up itself. */
type JobCleanup = (job: JobRow, how: { handlerRan: boolean }) => Promise<void>;
const cleanups = new Map<string, JobCleanup>();

/**
 * What to settle once a job of this type has ended, however it ended: finished, failed, stopped (also before it
 * started) or given up after restarts. Must be safe to run more than once.
 */
export function registerJobCleanup(type: string, cleanup: JobCleanup) {
  cleanups.set(type, cleanup);
}

export async function cleanUpJob(job: JobRow, how: { handlerRan: boolean }) {
  try {
    await cleanups.get(job.type)?.(job, how);
  } catch (err) {
    console.error(`[job:${job.type}] cleanup`, err);
  }
}

export async function createJob(input: {
  /** The job's id, when something was tagged with it before the job existed (a verify-on-import run's leads). */
  id?: string;
  workspaceId: string;
  userId?: string | null;
  type: string;
  entityId?: string | null;
  entityType?: string | null;
  /** What the job shows: settings and counts, kept small (it's read every second while someone watches the job). */
  data?: Record<string, unknown>;
  /** Large input the job works through (the rows of an import): kept apart from the job, removed when it ends. */
  input?: unknown;
  /** Input that must never be readable from the job (mailbox passwords): stored encrypted, removed when the job ends. */
  secret?: unknown;
}): Promise<JobRow> {
  const id = input.id ?? uuidv7();
  const insertJob = db
    .insert(schema.backgroundJobs)
    .values({
      id,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      type: input.type,
      entityId: input.entityId ?? null,
      entityType: input.entityType ?? null,
      data: input.data ?? {},
      status: "pending",
    })
    .returning();
  if (input.input === undefined && input.secret === undefined) return (await insertJob)[0]!;
  // Both or neither: a job never starts without its input.
  const [[job]] = await db.batch([
    insertJob,
    db.insert(schema.jobInputs).values({ jobId: id, input: input.input ?? null, sealed: input.secret !== undefined ? encryptJson(input.secret) : null }),
  ]);
  return job!;
}

/** A job's stored input and secret (secrets of jobs queued before inputs were kept apart live in its data). */
export async function loadJobInput(job: Pick<JobRow, "id" | "data">): Promise<{ input: unknown; secret: unknown }> {
  const [row] = await db.select().from(schema.jobInputs).where(eq(schema.jobInputs.jobId, job.id)).limit(1);
  return { input: row?.input ?? null, secret: row?.sealed ? decryptJson(row.sealed) : openJobSecret(job) };
}

/** Removes what a job was given to work through, once it has ended (or was stopped before it started). */
export async function dropJobInput(jobId: string) {
  await db.delete(schema.jobInputs).where(eq(schema.jobInputs.jobId, jobId));
  await db.delete(schema.jobInputParts).where(eq(schema.jobInputParts.jobId, jobId));
}

/** Stores part `seq` (2, 3…) of a job's input; a part sent again is kept once. */
export async function addJobInputPart(jobId: string, seq: number, input: unknown) {
  await db.insert(schema.jobInputParts).values({ jobId, seq, input }).onConflictDoNothing();
}

/** Part `seq` of a job's input, or null while it hasn't arrived. */
export async function jobInputPart<T>(jobId: string, seq: number): Promise<T | null> {
  const P = schema.jobInputParts;
  const [row] = await db.select({ input: P.input }).from(P).where(and(eq(P.jobId, jobId), eq(P.seq, seq))).limit(1);
  return row ? ((row.input ?? null) as T | null) : null;
}

/** Where a job's encrypted secret lives inside `data`. */
export const SEALED = "_sealed";

export function openJobSecret<T>(job: Pick<JobRow, "data">): T | null {
  return decryptJson<T>((job.data as Record<string, unknown> | null)?.[SEALED] as string | undefined);
}

/** Job data without the sealed secret. */
export function withoutSecret(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const { [SEALED]: _sealed, ...rest } = data as Record<string, unknown>;
  return rest;
}

const SECRET_KEY = /(^|_)(password|passwd|pass|secret|token|api_?key)(_|$)|_enc$/i;

/** Hides anything that looks like a credential, however a handler stored it. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v ? "[hidden]" : redact(v, depth + 1)]));
}

export function serializeJob(j: JobRow) {
  return {
    id: j.id,
    workspace_id: j.workspaceId,
    user_id: j.userId,
    type: j.type,
    entity_id: j.entityId,
    entity_type: j.entityType,
    data: redact(withoutSecret(j.data)),
    result: redact(j.result),
    progress: Math.round(j.progress),
    status: j.status,
    error: j.error,
    created_at: iso(j.createdAt),
    updated_at: iso(j.updatedAt),
  };
}

export async function getJob(id: string) {
  const [j] = await db.select().from(schema.backgroundJobs).where(eq(schema.backgroundJobs.id, id)).limit(1);
  return j ?? null;
}
