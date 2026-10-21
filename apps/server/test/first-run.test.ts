// A new installation (services/installation.ts, routes/auth.ts, the public config): its first account can always be
// made and runs it; after that, people need an invitation unless the owner lets anyone sign up.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { PASSWORD, TestClient, expectStatus, json, signUp, startServer, stopServer, uniqueEmail, type TestUser } from "./helpers/app";

let app: FastifyInstance;
let owner: TestUser;

before(async () => {
  app = await startServer({ installationDefaults: true });
});
after(stopServer);

const publicConfig = async () => json(await new TestClient(app).get("/api/public/config"));
const strangerSignsUp = () => new TestClient(app).post("/api/app/auth/signup", { email: uniqueEmail("stranger"), password: PASSWORD });

describe("a new installation", () => {
  it("lets its first account in and makes it the owner, then takes invited people only", async () => {
    const fresh = await publicConfig();
    assert.equal(fresh.first_run, true);
    assert.equal(fresh.signup_mode, "invite");

    owner = await signUp(app, { firstName: "First" });
    assert.equal(owner.me.features.owner, true);
    const later = await publicConfig();
    assert.equal(later.first_run, false);
    assert.equal(later.signup_mode, "invite");

    const stranger = await strangerSignsUp();
    expectStatus(stranger, 403);
    assert.equal(stranger.json().code, "signup_closed");

    const invitee = uniqueEmail("invitee");
    const invite = json(await owner.client.post("/api/v2/workspace-members", { email: invitee, role: "editor" }));
    const joined = await signUp(app, { email: invitee, inviteToken: new URL(invite.invite_url).searchParams.get("token")! });
    assert.equal(joined.me.workspace.id, owner.workspaceId);
    assert.equal(joined.me.features.owner, false);
  });

  it("lets anyone sign up once the owner opens it", async () => {
    expectStatus(await owner.client.patch("/api/app/admin/settings", { signup_mode: "open" }), 200);
    assert.equal((await publicConfig()).signup_mode, "open");
    expectStatus(await strangerSignsUp(), 200);
  });
});
