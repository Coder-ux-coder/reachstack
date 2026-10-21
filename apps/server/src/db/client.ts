import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { config } from "../env";
import * as schema from "./schema";

export type DB = LibSQLDatabase<typeof schema>;

const here = path.dirname(fileURLToPath(import.meta.url));

export const client: Client = createClient({ url: pathToFileURL(config.dbFile).href });
export const db: DB = drizzle(client, { schema });

let ready: Promise<void> | null = null;

export function initDb(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await client.execute("PRAGMA journal_mode = WAL");
      await client.execute("PRAGMA synchronous = NORMAL");
      await client.execute("PRAGMA busy_timeout = 15000");
      await client.execute("PRAGMA foreign_keys = OFF");
      await migrate(db, { migrationsFolder: path.resolve(here, "../../drizzle") });
    })();
  }
  return ready;
}

/** Whether a write failed because a row with the same unique key exists (two requests at once, a double click). */
export function isDuplicate(err: unknown): boolean {
  let e = err as { cause?: unknown; code?: unknown; extendedCode?: unknown } | null | undefined;
  for (let depth = 0; e && depth < 4; depth++, e = e.cause as typeof e) {
    const code = String(e.extendedCode ?? e.code ?? "");
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  }
  return false;
}

/** `term` for a LIKE pattern, its own %, _ and \ taken as themselves: the pattern goes with `escape '\'`. */
export const escapeLike = (term: string) => term.replace(/[\\%_]/g, (m) => `\\${m}`);

/** `column LIKE '%term%'` that finds the term as written: a search for "a_b" doesn't find "axb", nor "50%" "500". */
export const contains = (column: SQLWrapper, term: string): SQL => sql`${column} like ${`%${escapeLike(term)}%`} escape '\\'`;

export { schema };
