// Runs one forced Lead Finder Agent check against the local mock API and prints the outcome (dev only).
// usage (repo root): ANTHROPIC_BASE_URL=http://localhost:4999 ANTHROPIC_API_KEY=test-key npx tsx tools/dev/mock/check-lfa.mts <agentId> <campaignId>
const SRC = new URL("../../../apps/server/src", import.meta.url).href;
const { db, schema } = await import(`${SRC}/db/client.ts`);
const { checkLeadFinderAgent } = await import(`${SRC}/services/agents/lead-finder-agent.ts`);
const { eq, asc } = await import("drizzle-orm");
const [agentId, campaignId] = process.argv.slice(2);
await checkLeadFinderAgent(agentId!, { force: true });
const ev = await db.select().from(schema.aiAgentEvents).where(eq(schema.aiAgentEvents.agentId, agentId!)).orderBy(asc(schema.aiAgentEvents.id));
for (const e of ev) console.log("event", e.eventType, JSON.stringify(e.payload));
const leads = await db.select().from(schema.leads).where(eq(schema.leads.campaignId, campaignId!));
console.log("leads", leads.length, "statuses", JSON.stringify(leads.reduce((m: Record<string, number>, l: any) => ((m[l.status] = (m[l.status] ?? 0) + 1), m), {})));
for (const l of leads.slice(0, 3)) console.log(" ", l.firstName, "|", (l.payload as any)?.opener, "|", (l.payload as any)?.pain);
process.exit(0);
