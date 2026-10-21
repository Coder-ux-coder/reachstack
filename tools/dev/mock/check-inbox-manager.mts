// Runs one Inbox Manager pass against the local mock API and prints what it drafted (dev only).
// usage (repo root): ANTHROPIC_BASE_URL=http://localhost:4999 ANTHROPIC_API_KEY=test-key npx tsx tools/dev/mock/check-inbox-manager.mts <agentId>
const SRC = new URL("../../../apps/server/src", import.meta.url).href;
const { db, schema } = await import(`${SRC}/db/client.ts`);
const { runInboxManager } = await import(`${SRC}/services/agents/inbox-manager.ts`);
const { eq, desc } = await import("drizzle-orm");
const agentId = process.argv[2]!;
const [agent] = await db.select().from(schema.aiAgents).where(eq(schema.aiAgents.id, agentId));
console.log("drafted", await runInboxManager(agent));
const rows = await db.select().from(schema.aiAgentReplies).where(eq(schema.aiAgentReplies.agentId, agentId)).orderBy(desc(schema.aiAgentReplies.createdAt));
for (const r of rows) console.log(JSON.stringify({ lead: r.leadEmail, job: r.jobType, status: r.sendingStatus, pending: r.actionPending, hitl: r.requiresHitl, reason: r.requiresHitlReason, conf: r.confidenceScore, info: r.informationRequested, cal: r.calendlyToolUsed, err: r.errorCode, sendAt: r.scheduledSendAt, html: (r.html ?? "").slice(0, 160) }));
const ev = await db.select().from(schema.aiAgentEvents).where(eq(schema.aiAgentEvents.agentId, agentId));
for (const e of ev) console.log("event", e.eventType, JSON.stringify(e.payload));
process.exit(0);
