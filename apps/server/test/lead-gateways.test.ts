// Security gateways and mailbox providers of leads (lib/dns.ts, services/verification.ts): read from the domain's MX
// records (and its SPF record when a gateway hides the provider), filled in by the engine loop, filterable, and kept
// when a campaign's leads are copied.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { EsgCode, EspCode } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";
import { gatewayFromMx, providerFromMx, providerFromSpf } from "../src/lib/dns";
import { detectLeadEsps, resetGatewayPass } from "../src/services/verification";

const L = schema.leads;

describe("MX and SPF records", () => {
  it("name the security gateway in front of a domain", () => {
    const cases: Array<[string[], number]> = [
      [["mx0a-00123456.pphosted.com", "mx0b-00123456.pphosted.com"], EsgCode.PROOFPOINT],
      [["mx1-us1.ppe-hosted.com"], EsgCode.PROOFPOINT],
      [["us-smtp-inbound-1.mimecast.com", "us-smtp-inbound-2.mimecast.com"], EsgCode.MIMECAST],
      [["za-smtp-inbound-1.mimecast.co.za"], EsgCode.MIMECAST],
      [["d123456a.ess.barracudanetworks.com"], EsgCode.BARRACUDA],
      [["mx1.hc1234-56.iphmx.com."], EsgCode.CISCO],
      [["mx-01-eu-central-1.prod.hydra.sophos.com"], EsgCode.SOPHOS],
      [["acme-com.in.tmes.trendmicro.eu"], EsgCode.TREND_MICRO],
      [["cluster9.us.messagelabs.com"], EsgCode.BROADCOM],
      [["cluster5.eu.mailcontrol.com"], EsgCode.FORCEPOINT],
      [["mx-gate01-haj2.hornetsecurity.com"], EsgCode.HORNETSECURITY],
      [["mailstream-east.mxrecord.io"], EsgCode.CLOUDFLARE],
      // A gateway listed after the mailbox host still counts.
      [["acme-com.mail.protection.outlook.com", "us-smtp-inbound-1.mimecast.com"], EsgCode.MIMECAST],
      [["aspmx.l.google.com", "alt1.aspmx.l.google.com"], EsgCode.NONE],
      [["acme-com.mail.protection.outlook.com"], EsgCode.NONE],
      // Names that only look like a gateway's.
      [["mail.mimecast-fans.example"], EsgCode.NONE],
      [["mx.notpphosted.com"], EsgCode.NONE],
    ];
    for (const [mx, code] of cases) assert.equal(gatewayFromMx(mx), code, mx.join(" "));
  });

  it("name the mailbox provider, from SPF when a gateway hides it", () => {
    assert.equal(providerFromMx(["aspmx.l.google.com"]), EspCode.GOOGLE);
    assert.equal(providerFromMx(["acme-com.mail.protection.outlook.com"]), EspCode.MICROSOFT);
    assert.equal(providerFromMx(["us-smtp-inbound-1.mimecast.com"]), EspCode.OTHER);
    assert.equal(providerFromSpf(["v=spf1 include:spf.protection.outlook.com include:_netblocks.mimecast.com -all"]), EspCode.MICROSOFT);
    assert.equal(providerFromSpf(["google-site-verification=abc", "v=spf1 include:_spf.google.com ~all"]), EspCode.GOOGLE);
    assert.equal(providerFromSpf(["v=spf1 include:zoho.eu ~all"]), EspCode.ZOHO);
    // Both, or neither: no telling which one holds the mailboxes.
    assert.equal(providerFromSpf(["v=spf1 include:_spf.google.com include:spf.protection.outlook.com ~all"]), null);
    assert.equal(providerFromSpf(["v=spf1 ip4:192.0.2.1 -all"]), null);
    assert.equal(providerFromSpf([]), null);
  });
});

describe("gateways of leads", () => {
  let user: TestUser;
  let campaignId: string;
  const MIMECAST_M365 = ["ann@acme-mimecast-m365.test", "ben@acme-mimecast-m365.test"];
  before(async () => {
    const app = await startServer();
    await signUp(app); // the installation owner
    user = await signUp(app, { workspaceName: "Gateways" });
    campaignId = json(await user.client.post("/api/app/campaigns", { name: "Gateways" })).id;
  });
  after(stopServer);

  const listed = async (filter: Record<string, unknown>, campaign = campaignId) =>
    json<{ items: Array<{ email: string; esp_code: number; esg_code: number }> }>(await user.client.post("/api/v2/leads/list", { campaign, limit: 100, ...filter })).items;
  const codes = async (campaign = campaignId) => Object.fromEntries((await listed({}, campaign)).map((l) => [l.email, [l.esp_code, l.esg_code]]));
  const emails = async (filter: Record<string, unknown>) => (await listed(filter)).map((l) => l.email).sort();

  it("are looked up by the engine, with free mail settled when the lead is added", async () => {
    for (const email of [...MIMECAST_M365, "cat@globex-proofpoint.test", "dan@initech.test", "eve@gmail.com", "fay@unreachable-example.com"]) {
      json(await user.client.post("/api/v2/leads", { email, campaign: campaignId }));
    }
    const added = await codes();
    assert.deepEqual(added["eve@gmail.com"], [EspCode.GOOGLE, EsgCode.NONE]);
    assert.deepEqual(added["ann@acme-mimecast-m365.test"], [EspCode.IN_QUEUE, EsgCode.IN_QUEUE]);
    resetGatewayPass();
    await detectLeadEsps();
    assert.deepEqual(await codes(), {
      "ann@acme-mimecast-m365.test": [EspCode.MICROSOFT, EsgCode.MIMECAST],
      "ben@acme-mimecast-m365.test": [EspCode.MICROSOFT, EsgCode.MIMECAST],
      "cat@globex-proofpoint.test": [EspCode.OTHER, EsgCode.PROOFPOINT],
      "dan@initech.test": [EspCode.OTHER, EsgCode.NONE],
      "eve@gmail.com": [EspCode.GOOGLE, EsgCode.NONE],
      // Its DNS can't be read (tests have no network): both wait for another try.
      "fay@unreachable-example.com": [EspCode.IN_QUEUE, EsgCode.IN_QUEUE],
    });
  });

  it("can be filtered on, in the filter builder and the API", async () => {
    const gated = [...MIMECAST_M365, "cat@globex-proofpoint.test"].sort();
    assert.deepEqual(await emails({ rules: [{ field: "gateway", op: "is", value: [EsgCode.MIMECAST, EsgCode.PROOFPOINT] }] }), gated);
    assert.deepEqual(await emails({ rules: [{ field: "gateway", op: "is_not", value: [EsgCode.NONE, EsgCode.IN_QUEUE] }] }), gated);
    assert.deepEqual(await emails({ esg_code: "none" }), ["dan@initech.test", "eve@gmail.com"]);
    assert.deepEqual(await emails({ esg_code: String(EsgCode.MIMECAST) }), MIMECAST_M365);
    assert.deepEqual(await emails({ esg_code: "0" }), ["fay@unreachable-example.com"]);
    json(await user.client.post("/api/v2/leads/list", { campaign: campaignId, rules: [{ field: "gateway", op: "is", value: ["mimecast"] }] }), 400);
  });

  it("are filled in for leads that had a provider before, keeping their updated time", async () => {
    const old = new Date("2030-01-01T00:00:00.000Z");
    const backfilled = ["ann@acme-mimecast-m365.test", "dan@initech.test", "fay@unreachable-example.com"];
    // As leads added before gateways were checked: a provider, no gateway yet.
    await db.update(L).set({ esgCode: EsgCode.IN_QUEUE, updatedAt: old }).where(inArray(L.email, backfilled));
    await db.update(L).set({ espCode: EspCode.OTHER, updatedAt: old }).where(eq(L.email, "fay@unreachable-example.com"));
    resetGatewayPass();
    await detectLeadEsps();
    const rows = await db.select({ email: L.email, esp: L.espCode, esg: L.esgCode, updatedAt: L.updatedAt }).from(L).where(inArray(L.email, backfilled));
    assert.deepEqual(rows.map((r) => [r.email, r.esp, r.esg]).sort(), [
      ["ann@acme-mimecast-m365.test", EspCode.MICROSOFT, EsgCode.MIMECAST],
      ["dan@initech.test", EspCode.OTHER, EsgCode.NONE],
      ["fay@unreachable-example.com", EspCode.OTHER, EsgCode.IN_QUEUE], // its lookup failed: the next pass tries again
    ]);
    for (const r of rows) assert.equal(r.updatedAt.toISOString(), old.toISOString(), r.email!);
  });

  it("check leads that already have a provider a pass at a time, the next pass an hour later", async () => {
    const dan = () => db.select({ esg: L.esgCode }).from(L).where(eq(L.email, "dan@initech.test"));
    const t = Date.parse("2030-01-02T10:00:00Z");
    resetGatewayPass();
    await detectLeadEsps(t); // finishes a pass
    await db.update(L).set({ esgCode: EsgCode.IN_QUEUE }).where(eq(L.email, "dan@initech.test"));
    await detectLeadEsps(t + 60_000);
    assert.deepEqual(await dan(), [{ esg: EsgCode.IN_QUEUE }]);
    await detectLeadEsps(t + 3_600_000);
    assert.deepEqual(await dan(), [{ esg: EsgCode.NONE }]);
  });

  it("go with leads copied into a duplicate campaign", async () => {
    const copy = json(await user.client.post(`/api/v2/campaigns/${campaignId}/duplicate`, { copy_leads: true }));
    const copied = await codes(copy.id);
    assert.deepEqual(copied["cat@globex-proofpoint.test"], [EspCode.OTHER, EsgCode.PROOFPOINT]);
    assert.deepEqual(copied["eve@gmail.com"], [EspCode.GOOGLE, EsgCode.NONE]);
  });
});
