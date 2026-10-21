// Pure functions from @reachstack/shared that both the sending engine and the web app rely on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_MODULES_ON,
  API_SCOPE_RESOURCES,
  INSTALLATION_MODULES,
  NEW_WORKSPACE_MODES,
  PERMISSIONS,
  PLANS,
  ROLES,
  SIGNUP_MODES,
  canWrite,
  emailFromCell,
  emailsIn,
  escapeHtml,
  extractVariables,
  htmlToText,
  isLeadFieldName,
  isValidEmailSyntax,
  resolveDate,
  leadVariables,
  peopleIn,
  planById,
  renameVariable,
  renderTemplate,
  roleAllows,
  scopeAllows,
  senderVariables,
  splitFullName,
  textToHtml,
  timeVariables,
  validateBraces,
  variableUses,
} from "@reachstack/shared";

describe("template variables", () => {
  const vars = { firstName: "Ana", lastName: "", email: "ana@example.test", company: { name: "Acme", tags: ["red", "blue"] } };

  it("fills in variables, ignoring spaces inside the braces", () => {
    const r = renderTemplate("Hi {{firstName}}, {{ email }}", vars);
    assert.equal(r.output, "Hi Ana, ana@example.test");
    assert.deepEqual(r.warnings, []);
  });

  it("uses the fallback when the value is empty or missing", () => {
    assert.equal(renderTemplate("Hi {{lastName | there}}", vars).output, "Hi there");
    assert.equal(renderTemplate("Hi {{nickname|friend}}", vars).output, "Hi friend");
  });

  it("renders an unknown variable empty with a warning, or keeps it when asked", () => {
    const r = renderTemplate("Hi {{nickname}}!", vars);
    assert.equal(r.output, "Hi !");
    assert.deepEqual(r.warnings, [{ kind: "unresolved", token: "{{nickname}}" }]);
    assert.equal(renderTemplate("Hi {{nickname}}!", vars, { keepUnresolved: true }).output, "Hi {{nickname}}!");
  });

  it("matches names regardless of case and follows nested paths", () => {
    assert.equal(renderTemplate("{{FIRSTNAME}} at {{company.name}} ({{company.tags[1]}})", vars).output, "Ana at Acme (blue)");
  });

  it("escapes values in an HTML body, except the signature, which is HTML already", () => {
    const r = renderTemplate("<p>Hi {{firstName}}</p>{{accountSignature}}", { firstName: "<b>Ana</b>", accountSignature: "<p>Sam<br>Sales</p>" }, { escapeHtml: true });
    assert.equal(r.output, "<p>Hi &lt;b&gt;Ana&lt;/b&gt;</p><p>Sam<br>Sales</p>");
  });

  it("warns instead of printing objects or whole lists", () => {
    const r = renderTemplate("[{{company}}][{{company.tags}}]", vars);
    assert.equal(r.output, "[][]");
    assert.deepEqual(r.warnings.map((w) => w.kind).sort(), ["array_index_required", "structured_leaf"]);
  });

  it("HTML-escapes inserted values for HTML bodies but keeps the template's own markup", () => {
    const v = { firstName: `<img src=x onerror="alert(1)">`, company: "Smith & Sons" };
    const html = renderTemplate("<p>Hi <b>{{firstName}}</b> from {{company}}</p>", v, { escapeHtml: true });
    assert.equal(html.output, "<p>Hi <b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b> from Smith &amp; Sons</p>");
    // Plain-text parts (subjects, text bodies) keep the value as typed.
    assert.equal(renderTemplate("{{company}}", v).output, "Smith & Sons");
  });

  it("writes each value for its place in an HTML body: text keeps line breaks, addresses are encoded", () => {
    const v = {
      personalization: "Loved your talk.\n\nQuick idea",
      website: "https://example.com/a b",
      company: "AT&T",
      ref: "Shop #1",
      slug: "sam/30min",
      utm: "utm_source=x&utm_medium=y",
    };
    const r = (t: string) => renderTemplate(t, v, { escapeHtml: true }).output;
    assert.equal(r("<p>{{personalization}}</p>"), "<p>Loved your talk.<br><br>Quick idea</p>");
    assert.equal(r(`<a href="{{website}}">site</a>`), `<a href="https://example.com/a%20b">site</a>`);
    assert.equal(r(`<a href="https://x.test/?c={{company}}&r={{ref}}">x</a>`), `<a href="https://x.test/?c=AT%26T&r=Shop%20%231">x</a>`);
    // A path or a whole query string keeps its slashes and its own & and =.
    assert.equal(r(`<a href="https://cal.test/{{slug}}?{{utm}}">book</a>`), `<a href="https://cal.test/sam/30min?utm_source=x&amp;utm_medium=y">book</a>`);
    assert.equal(r(`<img alt="{{company}}" src="https://x.test/i.png">`), `<img alt="AT&amp;T" src="https://x.test/i.png">`);
    // Subjects and text parts take the value as typed.
    assert.equal(renderTemplate("{{personalization}}", v).output, "Loved your talk.\n\nQuick idea");
  });

  it("finds variables however they're cased or written in HTML, and treats a value of only spaces as empty", () => {
    const sig = { accountSignature: "<p>Sam<br>CEO</p>" };
    assert.equal(renderTemplate("{{AccountSignature}}", sig, { escapeHtml: true }).output, "<p>Sam<br>CEO</p>");
    assert.equal(renderTemplate("<p>{{R&amp;D Budget}}</p>", { "R&D Budget": "$5k" }, { escapeHtml: true }).output, "<p>$5k</p>");
    assert.deepEqual(variableUses("<p>{{R&amp;D&nbsp;Budget | none}}</p>"), [{ name: "R&D Budget", fallback: "none" }]);
    assert.equal(renameVariable("<p>{{R&amp;D Budget | none}}</p>", "R&D Budget", "rd"), "<p>{{rd | none}}</p>");
    assert.equal(renderTemplate("Hi {{firstName | there}},", { firstName: "  " }).output, "Hi there,");
  });

  it("never runs template syntax that comes from a lead's own data", () => {
    const v = { firstName: "{{email}}", personalization: "{{RANDOM | a | b}}", email: "private@example.test" };
    assert.equal(renderTemplate("Hi {{firstName}} {{personalization}}", v).output, "Hi {{email}} {{RANDOM | a | b}}");
  });

  it("checks that braces are balanced", () => {
    assert.equal(validateBraces("Hi {{firstName}} {{RANDOM | a | {{b}}}}"), null);
    assert.notEqual(validateBraces("Hi {{firstName"), null);
    assert.notEqual(validateBraces("Hi firstName}}"), null);
  });

  it("lists the variables a template uses, including those inside spintax", () => {
    assert.deepEqual(extractVariables("{{firstName}} {{RANDOM | Hi {{companyName}} | Yo}} {{firstName | x}}").sort(), ["companyName", "firstName"]);
  });

  it("renames a variable wherever it's used, and nothing else", () => {
    const before = "<p>Hi {{ Company Size | your team }}, {{RANDOM | at {{company size}} | Hey}} {{companySizeNote}} {{x | {{Company Size}}}}</p>";
    assert.equal(
      renameVariable(before, "Company Size", "company_size"),
      "<p>Hi {{ company_size | your team }}, {{RANDOM | at {{company_size}} | Hey}} {{companySizeNote}} {{x | {{company_size}}}}</p>",
    );
    assert.equal(renameVariable("No variables here {not one}", "a", "b"), "No variables here {not one}");
    assert.equal(renameVariable("{{RANDOM | a | b}}", "random", "x"), "{{RANDOM | a | b}}");
  });

  it("knows the lead's own fields in both spellings", () => {
    for (const name of ["first_name", "firstName", "FIRSTNAME", " jobTitle ", "linkedin_url", "email", "Timezone"]) assert.equal(isLeadFieldName(name), true, name);
    for (const name of ["industry", "first name", "company_size", "firstNames"]) assert.equal(isLeadFieldName(name), false, name);
  });
});

describe("spintax", () => {
  const t = "{{RANDOM | Hi | Hello | Hey}} {{firstName}}";

  it("picks one option per render from the random source", () => {
    assert.equal(renderTemplate(t, { firstName: "Ana" }, { random: () => 0 }).output, "Hi Ana");
    assert.equal(renderTemplate(t, { firstName: "Ana" }, { random: () => 0.5 }).output, "Hello Ana");
    assert.equal(renderTemplate(t, { firstName: "Ana" }, { random: () => 0.9999 }).output, "Hey Ana");
  });

  it("only ever picks one of the options", () => {
    for (let i = 0; i < 50; i++) assert.match(renderTemplate(t, { firstName: "Ana" }).output, /^(Hi|Hello|Hey) Ana$/);
  });

  it("fills variables inside the chosen option, escaped like any other value", () => {
    const r = renderTemplate("{{random|Hi {{firstName}}|Hello}}", { firstName: "<b>Ana</b>" }, { random: () => 0, escapeHtml: true });
    assert.equal(r.output, "Hi &lt;b&gt;Ana&lt;/b&gt;");
  });

  it("copes with an empty option and with deep nesting", () => {
    assert.equal(renderTemplate("a{{Random |}}b", {}, { random: () => 0 }).output, "ab");
    const deep = "{{RANDOM | ".repeat(40) + "x" + "}}".repeat(40);
    assert.equal(typeof renderTemplate(deep, {}, { random: () => 0 }).output, "string");
  });
});

describe("lead, sender and time variables", () => {
  it("a lead's custom fields can't replace the standard ones", () => {
    const v = leadVariables({ email: "ana@example.test", first_name: "Ana", payload: { email: "other@example.test", firstName: "Eve", industry: "Retail" } });
    assert.equal(v.email, "ana@example.test");
    assert.equal(v.firstName, "Ana");
    assert.equal(v.industry, "Retail");
    assert.equal(v.lastName, "");
  });

  it("builds the sender's full name without stray spaces", () => {
    assert.equal(senderVariables({ email: "sender@example.test", first_name: "Sam", last_name: null }).sendingAccountFullName, "Sam");
  });

  it("works out date, weekday and time of day in the lead's timezone", () => {
    const at = new Date("2026-01-05T15:00:00Z");
    assert.deepEqual(timeVariables(at, "UTC"), { today: "January 5, 2026", day_of_week: "Monday", time_of_day: "afternoon" });
    assert.deepEqual(timeVariables(at, "Asia/Tokyo"), { today: "January 6, 2026", day_of_week: "Tuesday", time_of_day: "morning" });
  });
});

describe("HTML helpers", () => {
  it("escapes every character that matters in HTML", () => {
    assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
    assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  });

  it("turns HTML into text without scripts or styles", () => {
    const html = `<style>p{color:red}</style><p>Hi&nbsp;<b>Ana</b></p><script>alert(1)</script><a href="https://example.com/x">site</a>`;
    assert.equal(htmlToText(html), "Hi Ana\n\nsite (https://example.com/x)");
  });

  it("keeps paragraphs apart in text, lines and list items on their own, and whitespace as a browser shows it", () => {
    assert.equal(htmlToText("<p>Hi there,</p><p>Most teams waste hours.</p><p>Worth a look?</p>"), "Hi there,\n\nMost teams waste hours.\n\nWorth a look?");
    assert.equal(htmlToText("<div>one</div><div><br></div><div>two</div>"), "one\n\ntwo");
    assert.equal(htmlToText("<ul><li>a</li><li>b</li></ul><p>after</p>"), "• a\n• b\n\nafter");
    assert.equal(htmlToText("<p>Hello\n   world,\n  how are you?</p>\n<p>  Next</p>"), "Hello world, how are you?\n\nNext");
    assert.equal(htmlToText("a < b and c > d <3"), "a < b and c > d <3");
    assert.equal(htmlToText(`<div title=it's>x</div><img alt="a>b" src=x>y<!-- <p>no</p> -->`), "x\ny");
    assert.equal(htmlToText("<html><head><title>Hidden</title></head><body><p>Body</p></body></html>"), "Body");
    assert.equal(
      htmlToText(`<a href="https://x.test/?a=1&amp;b=2">https://x.test/?a=1&amp;b=2</a> <a href="mailto:me@x.test">mail</a> <a href="#top">top</a>`),
      "https://x.test/?a=1&b=2 mail (mailto:me@x.test) top",
    );
    assert.equal(htmlToText("Written as text\nwith its lines"), "Written as text\nwith its lines");
  });

  it("turns any HTML into text in time that grows with its length", () => {
    // Shapes that made the old regex-based conversion take seconds: openers that never close.
    for (const unit of ["<a x", "<style", "<a href='x'>", "<", "<!--", "<p>"]) {
      const started = performance.now();
      htmlToText(unit.repeat(Math.ceil(400_000 / unit.length)));
      const ms = performance.now() - started;
      // The old conversion took seconds on these; the margin is for slow machines.
      assert.ok(ms < 3_000, `${unit}: ${Math.round(ms)} ms`);
    }
  });

  it("turns text into HTML with the text escaped", () => {
    assert.equal(textToHtml("a<b>\nc"), "a&lt;b&gt;<br/>c");
  });
});

describe("roles and permissions", () => {
  it("owners and admins can do everything, whatever custom permissions say", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const p of PERMISSIONS) {
        assert.equal(roleAllows(role, p), true);
        assert.equal(roleAllows(role, p, ["dashboard"]), true);
      }
    }
  });

  it("editors manage everything except billing and the team", () => {
    assert.deepEqual(
      PERMISSIONS.filter((p) => !roleAllows("editor", p)),
      ["billing", "team"],
    );
  });

  it("view members only read, reply and look after email accounts", () => {
    assert.deepEqual(
      PERMISSIONS.filter((p) => roleAllows("view", p)),
      ["dashboard", "view_campaigns", "unibox", "analytics", "accounts"],
    );
  });

  it("clients get the default client areas, or exactly the areas they were given", () => {
    assert.deepEqual(
      PERMISSIONS.filter((p) => roleAllows("client", p)),
      ["dashboard", "view_campaigns", "unibox", "analytics"],
    );
    assert.deepEqual(
      PERMISSIONS.filter((p) => roleAllows("client", p, ["leads", "crm"])),
      ["leads", "crm"],
    );
    assert.equal(roleAllows("client", "dashboard", []), true);
  });

  it("only owners, admins and editors can write", () => {
    assert.deepEqual(
      ROLES.filter((r) => canWrite(r)),
      ["owner", "admin", "editor"],
    );
  });
});

describe("API key scopes", () => {
  it("grant exactly the resource and action named", () => {
    assert.equal(scopeAllows(["campaigns:read"], "campaigns", "read"), true);
    assert.equal(scopeAllows(["campaigns:read"], "campaigns", "update"), false);
    assert.equal(scopeAllows(["campaigns:read"], "leads", "read"), false);
    assert.equal(scopeAllows(["leads:read"], "lead_lists", "read"), false);
  });

  it("support all as a resource or action wildcard", () => {
    assert.equal(scopeAllows(["campaigns:all"], "campaigns", "delete"), true);
    assert.equal(scopeAllows(["all:read"], "leads", "read"), true);
    assert.equal(scopeAllows(["all:read"], "leads", "create"), false);
    assert.equal(scopeAllows(["all:all"], "api_keys", "create"), true);
  });

  it("ignore malformed scopes and empty lists", () => {
    assert.equal(scopeAllows([], "campaigns", "read"), false);
    assert.equal(scopeAllows(["campaigns"], "campaigns", "read"), false);
    assert.equal(scopeAllows([":read", "campaigns:", ":"], "campaigns", "read"), false);
    assert.equal(scopeAllows(["Campaigns:READ"], "campaigns", "read"), false);
  });

  it("lists each resource once", () => {
    assert.equal(new Set(API_SCOPE_RESOURCES).size, API_SCOPE_RESOURCES.length);
    assert.ok(API_SCOPE_RESOURCES.includes("all"));
  });
});

describe("plans", () => {
  it("have unique ids and can be found by id", () => {
    assert.equal(new Set(PLANS.map((p) => p.id)).size, PLANS.length);
    assert.equal(planById("outreach_growth")?.name, "Growth");
    assert.equal(planById("no_such_plan"), undefined);
    assert.equal(planById(null), undefined);
  });

  it("outreach tiers grow from one to the next", () => {
    const tiers = ["outreach_growth", "outreach_hypergrowth", "outreach_lightspeed"].map((id) => planById(id)!.limits);
    for (let i = 1; i < tiers.length; i++) {
      assert.ok(tiers[i]!.uploaded_contacts! > tiers[i - 1]!.uploaded_contacts!);
      assert.ok(tiers[i]!.monthly_emails! > tiers[i - 1]!.monthly_emails!);
    }
  });

  it("bundles carry the limits of the outreach and credit plans they combine", () => {
    for (const [bundle, outreach, credits] of [
      ["bundle_starter", "outreach_growth", "credits_growth"],
      ["bundle_scale", "outreach_hypergrowth", "credits_supersonic"],
      ["bundle_agency", "outreach_lightspeed", "credits_hyper"],
    ] as const) {
      const b = planById(bundle)!.limits;
      assert.equal(b.uploaded_contacts, planById(outreach)!.limits.uploaded_contacts, bundle);
      assert.equal(b.monthly_emails, planById(outreach)!.limits.monthly_emails, bundle);
      assert.equal(b.monthly_credits, planById(credits)!.limits.monthly_credits, bundle);
    }
  });

  it("cost something, and less per month when paid yearly", () => {
    for (const p of PLANS) {
      assert.ok(p.monthly_price > 0, p.id);
      assert.ok(p.yearly_price > 0 && p.yearly_price <= p.monthly_price, p.id);
    }
  });
});

describe("installation settings", () => {
  it("offer the three sign-up modes and two new-workspace modes", () => {
    assert.deepEqual([...SIGNUP_MODES], ["open", "invite", "closed"]);
    assert.deepEqual([...NEW_WORKSPACE_MODES], ["unlimited", "trial"]);
  });

  it("start with every product area switched on", () => {
    const keys = INSTALLATION_MODULES.map((m) => m.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(Object.keys(ALL_MODULES_ON).sort(), [...keys].sort());
    assert.ok(Object.values(ALL_MODULES_ON).every((v) => v === true));
  });
});

describe("a typed date in an automation", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const at = (v: string, zone?: string) => resolveDate(v, now, zone)?.toISOString() ?? null;

  it("is a time on the workspace's clock, and a date alone 9:00 there", () => {
    assert.equal(at("2026-03-01 15:00", "America/New_York"), "2026-03-01T20:00:00.000Z");
    assert.equal(at("2026-07-01T15:00", "America/New_York"), "2026-07-01T19:00:00.000Z", "summer time");
    assert.equal(at("2026-03-01", "America/New_York"), "2026-03-01T14:00:00.000Z");
    assert.equal(at("2026-03-01 15:00", "Asia/Kolkata"), "2026-03-01T09:30:00.000Z");
    assert.equal(at("2026-03-01T15:00:00Z", "America/New_York"), "2026-03-01T15:00:00.000Z", "a time that names its timezone keeps it");
    assert.equal(at("$now + 1d", "America/New_York"), "2026-10-17T12:00:00.000Z");
  });

  it("refuses a day that doesn't exist", () => {
    assert.equal(at("2026-02-30", "UTC"), null);
    assert.equal(at("2026-03-01 25:00", "UTC"), null);
    assert.equal(at("next week", "UTC"), null);
  });
});

describe("leads as people paste them", () => {
  it("finds the address in a cell, however it's written", () => {
    assert.equal(emailFromCell(" JO@Example.TEST "), "jo@example.test");
    assert.equal(emailFromCell("Jo Doe <jo.doe@example.test>"), "jo.doe@example.test");
    assert.equal(emailFromCell("mailto:jo+leads@example.test"), "jo+leads@example.test");
    assert.equal(emailFromCell("jo@example.test."), "jo@example.test");
    assert.equal(emailFromCell("jo@example.test; sam@example.test"), "jo@example.test", "the first of several");
    assert.equal(emailFromCell("Not an address"), "not an address", "left for the syntax check to refuse");
  });

  it("never takes part of an address for an address", () => {
    // Letters outside a-z: the whole address is kept for the syntax check to refuse, not a stranger's address inside it.
    for (const cell of ["jörg@firma.example.test", "MÜLLER@firma.example.test", "zoë.smith@example.test", "jo@sub.müller.example.test", "François <françois@example.test>"]) {
      const found = emailFromCell(cell);
      assert.equal(isValidEmailSyntax(found), false, `${cell} gave ${found}`);
    }
    assert.deepEqual(emailsIn("jörg@firma.example.test, ana@example.test\nKontakt: kim@example.test"), ["jörg@firma.example.test", "ana@example.test", "kim@example.test"]);
  });

  it("reads every address out of pasted text, each once", () => {
    const pasted = 'Jo Doe <jo@example.test>, sam@example.test\nSAM@example.test; "Ana" <ana@example.test>\nno address here';
    assert.deepEqual(emailsIn(pasted), ["jo@example.test", "sam@example.test", "ana@example.test"]);
  });

  it("keeps the names written in front of pasted addresses", () => {
    const people = (s: string) => peopleIn(s).map((p) => [p.email, p.first_name ?? "", p.last_name ?? ""]);
    assert.deepEqual(people('Jo Doe <jo@example.test>, sam@example.test\n"Ana Lee" <ana@example.test> Kim Park <KIM@example.test>'), [
      ["jo@example.test", "Jo", "Doe"],
      ["sam@example.test", "", ""],
      ["ana@example.test", "Ana", "Lee"],
      ["kim@example.test", "Kim", "Park"],
    ]);
    // Outlook's way: semicolons between people, so a comma is part of a name.
    assert.deepEqual(people("Doe, Jo <jo@example.test>; Sam Lee <sam@example.test>; jo@example.test"), [
      ["jo@example.test", "Jo", "Doe"],
      ["sam@example.test", "Sam", "Lee"],
    ]);
    assert.deepEqual(people("mailto:al@example.test lee@example.test"), [
      ["al@example.test", "", ""],
      ["lee@example.test", "", ""],
    ]);
  });

  it("splits a full name into first and last", () => {
    const split = (s: string) => Object.values(splitFullName(s));
    assert.deepEqual(split("Jo Doe"), ["Jo", "Doe"]);
    assert.deepEqual(split("  Jo   van  Doe "), ["Jo", "van Doe"]);
    assert.deepEqual(split("Doe, Jo"), ["Jo", "Doe"]);
    assert.deepEqual(split("Dr. Jo Doe"), ["Jo", "Doe"]);
    assert.deepEqual(split("Jo Doe, PhD"), ["Jo", "Doe"]);
    assert.deepEqual(split("Madonna"), ["Madonna", ""]);
    assert.deepEqual(split(""), ["", ""]);
  });
});
