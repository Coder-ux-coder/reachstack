// The blocklist's linked Google Sheet: read again each day, and an earlier error cleared once a read works.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { refreshBlockSheets } from "../src/services/blocklist";
import { patchWorkspaceSettings } from "../src/services/workspaces";

let app: FastifyInstance;
let user: TestUser;

before(async () => {
  app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Bo", workspaceName: "Block Co" });
});
after(stopServer);

describe("a linked blocklist sheet", () => {
  it("is read again a day later, and the error an earlier read left goes once a read works", async () => {
    const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await patchWorkspaceSettings(user.workspaceId!, {
      global_block_sheet_link: "https://docs.google.com/spreadsheets/d/sheet-test-1/edit#gid=0",
      global_block_sheet_synced_at: dayAgo,
      global_block_sheet_error: "Could not read the sheet.",
    });
    // Google's CSV export, answered here: nothing leaves the machine.
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response(["blocked.person@example.test", "example-blocked.test", ""].join("\n"), { status: 200, headers: { "content-type": "text/csv" } });
    }) as typeof fetch;
    try {
      await refreshBlockSheets();
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(asked, ["https://docs.google.com/spreadsheets/d/sheet-test-1/export?format=csv&gid=0"]);
    const settings = json(await user.client.get("/api/app/blocklist/settings"));
    assert.equal(settings.sheet_error, null);
    assert.notEqual(settings.sheet_synced_at, dayAgo);
    const blocked = await db.select({ value: schema.blockList.value }).from(schema.blockList).where(eq(schema.blockList.workspaceId, user.workspaceId!));
    assert.deepEqual(blocked.map((r) => r.value).sort(), ["blocked.person@example.test", "example-blocked.test"]);
  });
});
