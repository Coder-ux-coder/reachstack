// Prints every API route with its auth mode and API scope.
// Bearer credentials (API keys) only reach routes that declare a scope, so "-" rows are app-only.
import Fastify from "fastify";
import { registerRoutes } from "../routes";
import { apiEndpoints } from "../http/api-reference";

const app = Fastify();
const rows: string[] = [];
app.addHook("onRoute", (r) => {
  const cfg = (r.config ?? {}) as { auth?: string; scope?: [string, string] };
  const methods = Array.isArray(r.method) ? r.method.join(",") : r.method;
  if (methods === "HEAD") return;
  rows.push(`${(cfg.auth ?? "workspace").padEnd(9)} ${(cfg.scope ? cfg.scope.join(":") : "-").padEnd(36)} ${methods.padEnd(6)} ${r.url}`);
});
await registerRoutes(app);
await app.ready();
console.log(rows.sort().join("\n"));
const undescribed = apiEndpoints().filter((e) => !e.summary || e.group === "Other");
if (undescribed.length) {
  console.log("\nPublic API routes without a description or area on /developers (add them in http/api-reference.ts):");
  for (const e of undescribed) console.log(`  ${e.method} ${e.path}`);
}
process.exit(0);
