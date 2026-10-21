// Backups and restore (Settings → Installation → Backups, the installation owner only) and a workspace's "Download all
// data" export (Settings → Workspace & members, the workspace's owners and admins). Every backup route checks the
// owner before reading its input, so other people get a 403 whatever they send.
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity, BACKUP_FREQUENCIES, BACKUP_KEEP_MAX } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { config } from "../env";
import { ctx, type User } from "../http/context";
import { badRequest, HttpError, notFound, tooMany } from "../http/errors";
import { body, params } from "../http/util";
import { verifyPassword } from "../lib/crypto";
import { audit } from "../services/audit";
import { ArchiveError } from "../services/backup-archive";
import { cancelPendingRestore, formatBytes, freeBytes, stageRestore, UPLOAD_PREFIX, type RestoreSource } from "../services/backup-restore";
import { backupOverview, backupPath, deleteBackup, downloadName, setBackupSchedule, startBackup } from "../services/backups";
import { requireOwner } from "../services/instance";
import { createJob, getJob } from "../services/jobs";
import { exportView, slug, WORKSPACE_EXPORT_JOB, workspaceExportFile } from "../services/workspace-export";

const id = z.object({ id: z.string().min(1).max(200) });
/** Biggest backup the Backups page accepts (bigger ones can be restored with npm run restore). */
const MAX_UPLOAD = 50 * 1024 ** 3;

async function owner(req: FastifyRequest): Promise<User> {
  const me = ctx(req).user;
  await requireOwner(me);
  return me;
}

/** Wrong passwords per owner. Only wrong ones count, so trying several backup files isn't blocked. */
const wrongPasswords = new Map<string, { count: number; until: number }>();
const WRONG_PASSWORD_MAX = 10;
const WRONG_PASSWORD_WINDOW_MS = 15 * 60_000;

/** The owner's password again, as for handing over ownership (people who sign in with Google or Microsoft have none). */
async function checkPassword(me: User, password: unknown) {
  if (!me.passwordHash) return;
  const now = Date.now();
  const wrong = wrongPasswords.get(me.id);
  if (wrong && wrong.until > now && wrong.count >= WRONG_PASSWORD_MAX) throw tooMany("Too many attempts. Please try again in a few minutes.");
  if (await verifyPassword(typeof password === "string" ? password : "", me.passwordHash)) return;
  if (wrong && wrong.until > now) wrong.count++;
  else wrongPasswords.set(me.id, { count: 1, until: now + WRONG_PASSWORD_WINDOW_MS });
  throw badRequest("Incorrect password");
}

async function stage(archive: string, source: RestoreSource, me: User) {
  try {
    await stageRestore(config.dataDir, archive, { source, stagedBy: me.id });
  } catch (err) {
    if (err instanceof ArchiveError) throw badRequest(err.message);
    throw err;
  }
}

function sendFile(reply: FastifyReply, file: string, name: string, size: number, type: string) {
  reply
    .header("content-type", type)
    .header("content-length", String(size))
    .header("content-disposition", `attachment; filename="${name}"`)
    .header("cache-control", "no-store");
  return reply.send(createReadStream(file));
}

export default async function backupRoutes(app: FastifyInstance) {
  const user = { config: { auth: "user" as const } };

  // ---------- Backups (installation owner) ----------

  app.get("/api/app/admin/backups", user, async (req) => {
    await owner(req);
    return backupOverview();
  });

  app.post("/api/app/admin/backups", user, async (req, reply) => {
    await owner(req);
    await startBackup("manual");
    reply.code(202);
    return backupOverview();
  });

  app.patch("/api/app/admin/backups/schedule", user, async (req) => {
    await owner(req);
    const b = body(
      req,
      z
        .object({
          frequency: z.enum(BACKUP_FREQUENCIES).optional(),
          hour: z.number().int().min(0).max(23).optional(),
          weekday: z.number().int().min(1).max(7).optional(),
          keep: z.number().int().min(1).max(BACKUP_KEEP_MAX).optional(),
        })
        .strict(),
    );
    await setBackupSchedule(b);
    return backupOverview();
  });

  app.get("/api/app/admin/backups/:id/download", user, async (req, reply) => {
    await owner(req);
    const p = params(req, id);
    const file = backupPath(p.id);
    if (!file || !existsSync(file)) throw notFound("Backup");
    return sendFile(reply, file, downloadName(p.id), (await stat(file)).size, "application/gzip");
  });

  app.delete("/api/app/admin/backups/:id", user, async (req) => {
    await owner(req);
    if (!(await deleteBackup(params(req, id).id))) throw notFound("Backup");
    return { ok: true };
  });

  // Restore one of the backups kept on this server.
  app.post("/api/app/admin/backups/:id/restore", user, async (req) => {
    const me = await owner(req);
    const p = params(req, id);
    const b = body(req, z.object({ password: z.string().max(500).optional() }));
    await checkPassword(me, b.password);
    const file = backupPath(p.id);
    if (!file || !existsSync(file)) throw notFound("Backup");
    await stage(file, { type: "backup", name: p.id }, me);
    return backupOverview();
  });

  // Upload a backup to restore. Multipart: the field "password" first, then the file in "file".
  app.post("/api/app/admin/backups/restore", user, async (req) => {
    const me = await owner(req);
    const free = await freeBytes(config.dataDir);
    const length = Number(req.headers["content-length"] ?? 0);
    // The upload and the unpacked copy both need room.
    if (free !== null && length && free < length * 3) {
      throw new HttpError(507, `There isn't enough free disk space to restore this backup: it needs about ${formatBytes(length * 3)} and ${formatBytes(free)} is free.`, "insufficient_storage");
    }
    let part;
    try {
      part = await req.file({ limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5 } });
    } catch {
      throw badRequest("Choose a backup file to upload");
    }
    if (!part) throw badRequest("Choose a backup file to upload");
    const field = part.fields.password as { value?: unknown } | undefined;
    try {
      await checkPassword(me, field?.value);
    } catch (err) {
      part.file.resume();
      throw err;
    }
    const upload = path.join(config.dataDir, `${UPLOAD_PREFIX}${randomBytes(6).toString("hex")}.tar.gz`);
    try {
      try {
        await pipeline(part.file, createWriteStream(upload, { flags: "wx" }));
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw badRequest(`The file is bigger than ${formatBytes(MAX_UPLOAD)}. Restore it on the server with npm run restore instead.`);
        throw err;
      }
      if (part.file.truncated) throw badRequest(`The file is bigger than ${formatBytes(MAX_UPLOAD)}. Restore it on the server with npm run restore instead.`);
      await stage(upload, { type: "upload", name: path.basename(part.filename || "backup.tar.gz").slice(0, 200) }, me);
    } finally {
      await rm(upload, { force: true }).catch(() => undefined);
    }
    return backupOverview();
  });

  app.delete("/api/app/admin/backups/restore", user, async (req) => {
    await owner(req);
    if (!(await cancelPendingRestore(config.dataDir))) throw notFound("Waiting restore");
    return backupOverview();
  });

  // ---------- Download all data (a workspace's owners and admins) ----------

  const J = schema.backgroundJobs;
  const exportJobs = (wsId: string) => and(eq(J.workspaceId, wsId), eq(J.type, WORKSPACE_EXPORT_JOB));

  app.get("/api/app/workspace-export", { config: { admin: true } }, async (req) => {
    const rows = await db.select().from(J).where(exportJobs(ctx(req).wsId)).orderBy(desc(J.createdAt)).limit(5);
    return { items: await Promise.all(rows.map(exportView)) };
  });

  app.post("/api/app/workspace-export", { config: { admin: true } }, async (req) => {
    const c = ctx(req);
    const [active] = await db
      .select()
      .from(J)
      .where(and(exportJobs(c.wsId), inArray(J.status, ["pending", "in-progress"])))
      .limit(1);
    if (active) return exportView(active);
    const job = await createJob({ workspaceId: c.wsId, userId: c.userId, type: WORKSPACE_EXPORT_JOB, entityType: "workspace", entityId: c.wsId });
    await audit({ workspaceId: c.wsId, activityType: AuditActivity.LEAD_EXPORTED, req, metadata: { export: "all_workspace_data", job_id: job.id } });
    return exportView(job);
  });

  app.get("/api/app/workspace-export/:id/download", { config: { admin: true } }, async (req, reply) => {
    const c = ctx(req);
    const job = await getJob(params(req, id).id);
    if (!job || job.workspaceId !== c.wsId || job.type !== WORKSPACE_EXPORT_JOB || job.status !== "success") throw notFound("Export");
    const file = workspaceExportFile(job.id);
    if (!existsSync(file)) throw new HttpError(410, "This export was deleted after a few days. Prepare a new one.", "expired");
    const name = (job.result as { name?: string } | null)?.name ?? `${slug(c.workspace.name)}-export.tar.gz`;
    return sendFile(reply, file, name, (await stat(file)).size, "application/gzip");
  });
}
