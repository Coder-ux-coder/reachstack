// Runs SQL against the local database and prints up to 40 rows per query (dev only; it can also write, so be careful).
// usage: node tools/dev/dbq.mjs "select id, name from workspaces" ["<more sql>" ...]
// Env: DB_FILE (default data/app.db in the repo root).
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const file = process.env.DB_FILE || fileURLToPath(new URL("../../data/app.db", import.meta.url));
const c = createClient({ url: `file:${file.replace(/\\/g, "/")}` });
for (const q of process.argv.slice(2)) {
  const r = await c.execute(q);
  console.table(r.rows.slice(0, 40));
}
