// Sequence versions (Sequences tab → Versions): the saved states of a campaign's or a subsequence's sequence, a
// read-only preview of each, and "Restore this version", which saves those steps again as the newest version.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AuditActivity } from "@reachstack/shared";
import { db, schema } from "../db/client";
import { ctx } from "../http/context";
import { assertFound } from "../http/errors";
import { params } from "../http/util";
import { actorOf, audit } from "../services/audit";
import { serializeCampaign, type CampaignRow, type SubsequenceRow } from "../services/campaigns";
import { MAX_VERSIONS, findSequenceVersion, listSequenceVersions, recordSequenceVersion, sequenceKey, serializeVersion, type SequenceOwner, type VersionRow } from "../services/sequence-versions";
import { serializeSubsequence } from "../services/subsequences";
import { findCampaign } from "./campaigns";

const C = schema.campaigns;
const S = schema.subsequences;
const idParams = z.object({ id: z.string().min(1).max(64), version: z.string().min(1).max(64).optional() });

type Owner = { key: SequenceOwner; campaign: CampaignRow; sub: null } | { key: SequenceOwner; campaign: null; sub: SubsequenceRow };

async function ownerOf(req: FastifyRequest, kind: "campaigns" | "subsequences"): Promise<Owner> {
  const c = ctx(req);
  const { id } = params(req, idParams);
  if (kind === "campaigns") {
    const campaign = await findCampaign(c.wsId, id);
    return { key: { workspaceId: c.wsId, campaignId: campaign.id }, campaign, sub: null };
  }
  const [row] = await db
    .select()
    .from(S)
    .where(and(eq(S.id, id), eq(S.workspaceId, c.wsId)))
    .limit(1);
  const sub = assertFound(row, "Subsequence");
  return { key: { workspaceId: c.wsId, campaignId: sub.parentCampaignId, subsequenceId: sub.id }, campaign: null, sub };
}

async function versionOf(req: FastifyRequest, o: Owner): Promise<VersionRow> {
  return assertFound(await findSequenceVersion(o.key, params(req, idParams).version ?? ""), "Version");
}

const stepsOf = (o: Owner) => (o.campaign ? o.campaign.sequences : o.sub.sequences);

export default async function sequenceVersionRoutes(app: FastifyInstance) {
  const read = { perm: "view_campaigns" as const };
  const write = { perm: "edit_campaigns" as const, write: true };

  for (const kind of ["campaigns", "subsequences"] as const) {
    const base = `/api/app/${kind}/:id/sequence-versions`;

    app.get(base, { config: read }, async (req) => {
      const o = await ownerOf(req, kind);
      return { items: await listSequenceVersions(o.key, stepsOf(o)), max: MAX_VERSIONS };
    });

    app.get(`${base}/:version`, { config: read }, async (req) => {
      const o = await ownerOf(req, kind);
      const v = await versionOf(req, o);
      // "current" here: the same steps as the sequence holds now, so restoring it would change nothing.
      return serializeVersion(v, { current: sequenceKey(v.sequences) === sequenceKey(stepsOf(o)), withSteps: true });
    });

    // Replaces the sequence with the version's steps. What it held until now stays in the list, so this can be undone too.
    app.post(`${base}/:version/restore`, { config: write }, async (req) => {
      const o = await ownerOf(req, kind);
      const v = await versionOf(req, o);
      const actor = actorOf(req);
      if (o.campaign) {
        const [row] = await db.update(C).set({ sequences: v.sequences }).where(eq(C.id, o.campaign.id)).returning();
        await recordSequenceVersion({ ...o.key, before: o.campaign.sequences, after: row!.sequences, beforeAt: o.campaign.updatedAt, actor, source: "restore", restoredFrom: v.id });
        await audit({ workspaceId: o.key.workspaceId, activityType: AuditActivity.CAMPAIGN_UPDATE, req, campaignId: o.campaign.id, metadata: { fields: ["sequences"], action: "restore_version", version_id: v.id } });
        return serializeCampaign(row!);
      }
      const [row] = await db.update(S).set({ sequences: v.sequences }).where(eq(S.id, o.sub.id)).returning();
      await recordSequenceVersion({ ...o.key, before: o.sub.sequences, after: row!.sequences, beforeAt: o.sub.updatedAt, actor, source: "restore", restoredFrom: v.id });
      await audit({
        workspaceId: o.key.workspaceId,
        activityType: AuditActivity.SUBSEQUENCE_UPDATE,
        req,
        campaignId: o.sub.parentCampaignId,
        subsequenceId: o.sub.id,
        metadata: { fields: ["sequences"], action: "restore_version", version_id: v.id },
      });
      return serializeSubsequence(row!);
    });
  }
}
