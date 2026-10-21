// The launch check's gate (services/launch-check.ts, GET /api/app/campaigns/:id/launch-check): leads who'd get an
// email with a gap where a {{variable}} goes, with a preview of the worst of those emails; mailboxes without a name;
// links nobody can open; and emails with no way to opt out. All addresses are made up and nothing is sent.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { emptyVariables, variableUses } from "@reachstack/shared";
import { json, signUp, startServer, stopServer, type TestUser } from "./helpers/app";
import { db, schema } from "../src/db/client";

const ALWAYS_OPEN = {
  start_date: null,
  end_date: null,
  schedules: [{ name: "Always", timing: { from: "00:00", to: "00:00" }, days: { 0: true, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true }, timezone: "UTC" }],
};
const step = (subject: string, body: string) => ({ type: "email", delay: 1, delay_unit: "days", variants: [{ subject, body }] });
const OPT_OUT_LINE = "<p>Not the right time? Just reply 'stop'.</p>";

interface Check {
  ready: boolean;
  problems: string[];
  warnings: string[];
  personalization: null | {
    leads: number;
    checked: number;
    affected: number;
    gaps: Array<{ token: string; leads: number; steps: number[] }>;
    worst: null | { lead: { email: string }; step: number; missing: string[]; subject: Array<{ text?: string; missing?: string }>; body: string };
  };
}

let user: TestUser;
let sender: string;

before(async () => {
  const app = await startServer();
  await signUp(app); // the installation owner
  user = await signUp(app, { firstName: "Sam", workspaceName: "Gate Co" });
  sender = json(await user.client.post("/api/app/accounts/sandbox", { count: 1, enable_warmup: false })).items[0].email;
});
after(stopServer);

async function campaign(name: string, steps: unknown[], extra: Record<string, unknown> = {}) {
  const c = json(await user.client.post("/api/app/campaigns", { name }));
  json(await user.client.patch(`/api/v2/campaigns/${c.id}`, { email_list: [sender], campaign_schedule: ALWAYS_OPEN, sequences: [{ steps }], ...extra }));
  return c.id as string;
}
const addLead = async (campaignId: string, lead: Record<string, unknown>) => json(await user.client.post("/api/v2/leads", { ...lead, campaign: campaignId }));
const check = async (id: string) => json<Check>(await user.client.get(`/api/app/campaigns/${id}/launch-check`));

describe("empty variables", () => {
  it("are found for each lead's values, skipping fallbacks and counting spintax options", () => {
    const uses = variableUses("Hi {{firstName}}, {{RANDOM | about {{companyName}} | quick one}} {{title|}} {{city | your city}}");
    assert.deepEqual(emptyVariables(uses, { firstName: "Pat", companyName: "Acme" }), []);
    assert.deepEqual(emptyVariables(uses, { firstName: "  ", companyName: "" }), ["{{firstName}}", "{{companyName}}"]);
    assert.deepEqual(emptyVariables(uses, {}), ["{{firstName}}", "{{companyName}}"]);
  });
});

describe("leads who'd get a gap", () => {
  it("are counted per variable and step, with the worst email shown and its gaps marked", async () => {
    const id = await campaign("Gaps", [
      step("Hi {{firstName}}", `<p>{{firstName}}, a quick note about {{companyName}}.</p><p>{{title|}}</p>${OPT_OUT_LINE}`),
      step("", "<p>Following up, {{firstName|there}}. Any thoughts on {{fristName}}?</p>"),
    ]);
    await addLead(id, { email: "full@gate.test", first_name: "Pat", company_name: "Acme" });
    await addLead(id, { email: "no.name@gate.test", company_name: "Globex" });
    await addLead(id, { email: "nothing@gate.test" });
    // Leads that won't be emailed again don't count.
    const done = await addLead(id, { email: "done@gate.test" });
    await db.update(schema.leads).set({ status: 3 }).where(eq(schema.leads.id, done.id));

    const r = await check(id);
    assert.equal(r.ready, true);
    const p = r.personalization!;
    assert.equal(p.leads, 3);
    assert.equal(p.checked, 3);
    assert.equal(p.affected, 2);
    assert.deepEqual(p.gaps, [
      { token: "{{firstName}}", leads: 2, steps: [1] },
      { token: "{{companyName}}", leads: 1, steps: [1] },
    ]);
    // A variable no lead has is a typo, reported once as a warning rather than as everyone's gap.
    assert.ok(!p.gaps.some((g) => g.token === "{{fristName}}"));
    assert.match(r.warnings.join("\n"), /\{\{fristName\}\} in step 2 isn't a lead field/);

    const w = p.worst!;
    assert.equal(w.lead.email, "nothing@gate.test");
    assert.equal(w.step, 1);
    assert.deepEqual(w.missing, ["{{firstName}}", "{{companyName}}"]);
    assert.deepEqual(w.subject, [{ text: "Hi " }, { missing: "{{firstName}}" }]);
    assert.equal((w.body.match(/<mark /g) ?? []).length, 2);
    assert.doesNotMatch(w.body, /\u0000/);
  });

  it("only look at the steps each lead still has to get", async () => {
    const id = await campaign("Later steps", [step("Hi {{firstName}}", `<p>Hello</p>${OPT_OUT_LINE}`), step("", "<p>Thanks again</p>")]);
    const lead = await addLead(id, { email: "past.step.one@gate.test" });
    assert.equal((await check(id)).personalization?.gaps[0]?.token, "{{firstName}}");
    await db.update(schema.leads).set({ nextStep: 1 }).where(eq(schema.leads.id, lead.id));
    assert.equal((await check(id)).personalization, null);
  });

  it("is nothing to report when every lead has every value", async () => {
    const id = await campaign("All filled", [step("Hi {{firstName}}", `<p>About {{companyName}}</p>${OPT_OUT_LINE}`)]);
    await addLead(id, { email: "filled@gate.test", first_name: "Pat", company_name: "Acme" });
    assert.equal((await check(id)).personalization, null);
  });

  it("leaves a gap in a link's address unmarked, so the preview's HTML stays whole", async () => {
    const id = await campaign("Link gap", [step("Hello", `<p><a href="https://{{website}}/demo">See the demo</a> <a href="https://gate.example.test/book?site={{website}}">Book</a> {{firstName}}</p>${OPT_OUT_LINE}`)]);
    await addLead(id, { email: "no.site@gate.test" });
    const w = (await check(id)).personalization!.worst!;
    assert.match(w.body, /<a href="https:\/\/\/demo">See the demo<\/a> <a href="https:\/\/gate\.example\.test\/book\?site=">Book<\/a> <mark /);
  });
});

describe("other launch warnings", () => {
  it("name mailboxes without a name when the emails use it", async () => {
    await db.update(schema.emailAccounts).set({ firstName: "", lastName: "" }).where(eq(schema.emailAccounts.email, sender));
    const id = await campaign("Sender name", [step("Hello", `<p>I'm {{sendingAccountFirstName}}. {{sendingAccountLastName|}}</p>${OPT_OUT_LINE}`)]);
    const text = (await check(id)).warnings.join("\n");
    assert.match(text, new RegExp(`${sender.replace(/[.]/g, "\\.")} has no name set, so \\{\\{sendingAccountFirstName\\}\\} comes out empty`));
    assert.doesNotMatch(text, /sendingAccountLastName/);
  });

  it("flag links nobody can open, and leave real, personalized and mail links alone", async () => {
    const id = await campaign("Links", [
      step("Hello", `<p><a href="">here</a> <a href="https://yourwebsite.com/page">site</a> <a href="www.acme-real.com">www</a> <a href="https://acme-real.com/pricing">pricing</a></p>${OPT_OUT_LINE}`),
      step("", `<p><a href="https://{{website}}">you</a> <a href="mailto:hello@acme-real.com">mail</a> <a href="http://localhost:3000/x">local</a></p>`),
    ]);
    const text = (await check(id)).warnings.join("\n");
    assert.match(text, /Step 1 has a link without an address\./);
    assert.match(text, /Step 1 has a link to yourwebsite\.com, which looks like a placeholder\./);
    assert.match(text, /Step 1 has a link to "www\.acme-real\.com", which isn't a full web address/);
    assert.match(text, /Step 2 has a link to localhost, which people outside your network can't open\./);
    assert.doesNotMatch(text, /pricing|mailto|\{\{website\}\}/);
  });

  it("ask for a way to opt out unless an email offers one or the unsubscribe header is on", async () => {
    const noWayOut = await campaign("No way out", [step("Hello", "<p>Hello there</p>")]);
    assert.match((await check(noWayOut)).warnings.join("\n"), /None of the emails offers a way to opt out/);
    const replyStop = await campaign("Reply stop", [step("Hello", "<p>Hello there</p>"), step("", `<p>Last one.</p>${OPT_OUT_LINE}`)]);
    assert.doesNotMatch((await check(replyStop)).warnings.join("\n"), /opt out/);
    const link = await campaign("Unsubscribe link", [step("Hello", '<p>Hello there. <a href="{{unsubscribe_url}}">Unsubscribe</a></p>')]);
    assert.doesNotMatch((await check(link)).warnings.join("\n"), /opt out/);
    const header = await campaign("Header", [step("Hello", "<p>Hello there</p>")], { insert_unsubscribe_header: true });
    assert.doesNotMatch((await check(header)).warnings.join("\n"), /opt out/);
  });
});
