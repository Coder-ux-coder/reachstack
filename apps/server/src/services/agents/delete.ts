// Deleting an agent: the same clean-up from its own page and from the list's bulk delete.
import { and, eq, sql } from "drizzle-orm";
import type { Permission } from "@reachstack/shared";
import { db, schema } from "../../db/client";
import { conflict } from "../../http/errors";
import { AgentType, type AgentRow } from "./common";
import { SendingStatus } from "./inbox-manager";
import type { SalesAgentRow } from "./sales-agent";

/** What a member needs to delete an agent of this kind: what its own pages need to change it. */
export const agentPermission = (type: number): Permission => (type === AgentType.DELIVERABILITY ? "accounts" : type === AgentType.LEAD_FINDER ? "lead_finder" : "settings");

/**
 * Deletes an agent and what's only its: guidance, its activity, a deliverability agent's checks and feed. Replies it
 * scheduled are marked as never sent; the conversations stay in the Unibox.
 */
export async function deleteAgent(a: AgentRow) {
  const R = schema.aiAgentReplies;
  await db
    .update(R)
    .set({ sendingStatus: SendingStatus.FAILED, errorCode: "AGENT_NOT_FOUND", actionPending: false })
    .where(and(eq(R.agentId, a.id), eq(R.sendingStatus, SendingStatus.SCHEDULED)));
  await db.delete(schema.aiAgentGuidance).where(eq(schema.aiAgentGuidance.agentId, a.id));
  await db.delete(schema.aiAgentEvents).where(eq(schema.aiAgentEvents.agentId, a.id));
  await db.delete(schema.deliverabilityActivities).where(eq(schema.deliverabilityActivities.agentId, a.id));
  await db.delete(schema.deliverabilityCycles).where(eq(schema.deliverabilityCycles.agentId, a.id));
  await db.delete(schema.deliverabilityFeedItems).where(eq(schema.deliverabilityFeedItems.agentId, a.id));
  await db.delete(schema.aiAgents).where(eq(schema.aiAgents.id, a.id));
}

/** Deletes an AI Sales Agent with its activity and lead research. One that still has campaigns is refused. */
export async function deleteSalesAgent(a: SalesAgentRow) {
  const [linked] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.workspaceId, a.workspaceId), eq(schema.campaigns.aiSdrId, a.id)));
  if (Number(linked?.n ?? 0) > 0) throw conflict(`This agent still has ${Number(linked!.n)} campaign(s). Delete them or move them out of the agent first.`);
  await db.delete(schema.aiSalesAgentActivities).where(eq(schema.aiSalesAgentActivities.aiSdrId, a.id));
  await db.delete(schema.aiLeadResearch).where(eq(schema.aiLeadResearch.agentId, a.id));
  await db.delete(schema.aiSalesAgents).where(eq(schema.aiSalesAgents.id, a.id));
}
