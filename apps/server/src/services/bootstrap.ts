import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { LeadStatus, VerificationStatus } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { uuidv7 } from "../lib/ids";
import { getOwnerId, unmeterOwnedWorkspaces } from "./instance";
import { requeueStalledJobs } from "../engine/jobs";
import { createJob } from "./jobs";
import { startServiceSettingsSync } from "./service-settings";

/** One-time installation setup (idempotent). */
export async function bootstrapInstallation() {
  // Keys and services the owner saved in Settings → Installation → Services replace the .env values.
  await startServiceSettingsSync();
  const [row] = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, "installed_at")).limit(1);
  if (!row) {
    await db.insert(schema.appSettings).values({ key: "installed_at", value: new Date().toISOString() });
  }
  // Records the installation owner (the first account, on installs from before owners existed) and keeps every
  // workspace they own unmetered, including ones handed to them since the last start.
  const ownerId = await getOwnerId();
  if (ownerId) await unmeterOwnedWorkspaces(ownerId);
  await scrubOldImportJobs();
  await repairStuckVerification();
  await endSubsequencesOfEndedLeads();
  // Jobs a previous run of the app was in the middle of go back in the queue.
  await requeueStalledJobs();
}

/**
 * Leads can only send their first email once verification ends. Leads waiting for a run that doesn't exist (from
 * before 2026-10-15, when "verify on import" never queued one, or added just as the app stopped) get a run now. Leads
 * left "pending" by a run that is no longer active go back to "not verified".
 */
export async function repairStuckVerification() {
  const L = schema.leads;
  const J = schema.backgroundJobs;
  const active = await db
    .select({ workspaceId: J.workspaceId, data: J.data })
    .from(J)
    .where(and(eq(J.type, "verify-leads"), inArray(J.status, ["pending", "in-progress"])));
  // Leads tagged with a run that is gone stop waiting for it: the ones it had started on go back to "not verified".
  const activeRuns = sql`(select ${J.id} from ${J} where ${J.type} = 'verify-leads' and ${J.status} in ('pending', 'in-progress'))`;
  await db
    .update(L)
    .set({
      verificationStatus: sql`case when ${L.verificationStatus} = ${VerificationStatus.PENDING} then ${VerificationStatus.NOT_VERIFIED} else ${L.verificationStatus} end`,
      verifyRunId: null,
    })
    .where(and(isNotNull(L.verifyRunId), sql`${L.verifyRunId} not in ${activeRuns}`));
  // Untagged leads may be an active run's: a manual run's, or an import run's queued before runs tagged their leads.
  const busy = new Set(active.filter((j) => !(j.data as { own_leads?: boolean } | null)?.own_leads).map((j) => j.workspaceId));
  const waiting = await db
    .select({ workspaceId: L.workspaceId, status: L.verificationStatus })
    .from(L)
    .where(and(inArray(L.verificationStatus, [VerificationStatus.PENDING, VerificationStatus.PENDING_JOB]), isNull(L.verifyRunId)))
    .groupBy(L.workspaceId, L.verificationStatus);
  for (const w of waiting) {
    if (busy.has(w.workspaceId)) continue;
    if (w.status === VerificationStatus.PENDING) {
      await db
        .update(L)
        .set({ verificationStatus: VerificationStatus.NOT_VERIFIED })
        .where(and(eq(L.workspaceId, w.workspaceId), eq(L.verificationStatus, VerificationStatus.PENDING), isNull(L.verifyRunId)));
    } else {
      // One run for them, free: tagged first, so a stop in between leaves nothing behind that the next start misses.
      const id = uuidv7();
      await db
        .update(L)
        .set({ verifyRunId: id })
        .where(and(eq(L.workspaceId, w.workspaceId), eq(L.verificationStatus, VerificationStatus.PENDING_JOB), isNull(L.verifyRunId)));
      await createJob({ id, workspaceId: w.workspaceId, type: "verify-leads", data: { pending_import: true, own_leads: true, name: "Verify on import", charged: 0 } });
    }
  }
}

/**
 * Before 2026-10-16 a bounce or an unsubscribe left the lead's subsequence running (and its campaign "running
 * subsequences" for good): those subsequences end the way the lead did.
 */
async function endSubsequencesOfEndedLeads() {
  const L = schema.leads;
  await db
    .update(L)
    .set({ subseqStatus: sql`${L.status}`, subseqNextSendAt: null })
    .where(and(inArray(L.status, [LeadStatus.BOUNCED, LeadStatus.UNSUBSCRIBED]), inArray(L.subseqStatus, [LeadStatus.ACTIVE, LeadStatus.PAUSED])));
}

/**
 * Mailbox imports queued before their input was encrypted kept every mailbox password in the job's data. Finished
 * ones lose the passwords; waiting ones keep them until they run (the runner wipes them then).
 */
async function scrubOldImportJobs() {
  const rows = await db
    .select({ id: schema.backgroundJobs.id, data: schema.backgroundJobs.data })
    .from(schema.backgroundJobs)
    .where(and(eq(schema.backgroundJobs.type, "import-accounts"), sql`${schema.backgroundJobs.status} <> 'pending'`, sql`json_extract(${schema.backgroundJobs.data}, '$.accounts') is not null`));
  for (const r of rows) {
    const { accounts, ...rest } = (r.data ?? {}) as { accounts?: Array<{ email?: string }> };
    await db
      .update(schema.backgroundJobs)
      .set({ data: { ...rest, emails: (accounts ?? []).map((a) => a.email ?? "") } })
      .where(eq(schema.backgroundJobs.id, r.id));
  }
}
