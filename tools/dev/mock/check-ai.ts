// Classifies one reply with the configured AI (point ANTHROPIC_BASE_URL at the mock) and prints the result.
// usage (repo root): ANTHROPIC_BASE_URL=http://localhost:4999 ANTHROPIC_API_KEY=test-key npx tsx tools/dev/mock/check-ai.ts <workspaceId> ["reply text"]
import { classifyReply } from "../../../apps/server/src/services/reply-labels";

const [workspaceId, text = "Sounds interesting, what times work next week?"] = process.argv.slice(2);
if (!workspaceId) {
  console.error("usage: npx tsx tools/dev/mock/check-ai.ts <workspaceId> [reply text]");
  process.exit(1);
}
const r = await classifyReply(workspaceId, text);
console.log(JSON.stringify(r));
process.exit(0);
