// /developers — the public API reference. The endpoint list comes from the server's own routes
// (GET /api/public/api-reference), so it always matches what this installation can do.
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { API_SCOPE_RESOURCES, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_TYPES } from "@reachstack/shared";
import { get } from "@/lib/api";
import { useBrand } from "@/lib/session";
import { CopyButton, EmptyState, NativeSelect, SearchInput, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MarketingLayout } from "./Layout";

interface Endpoint {
  method: string;
  path: string;
  scope: string;
  group: string;
  summary: string;
}

const GUIDES: Array<[id: string, label: string]> = [
  ["getting-started", "Getting started"],
  ["authentication", "Authentication"],
  ["pagination", "Pagination"],
  ["errors", "Errors"],
  ["scopes", "Scopes"],
  ["webhooks", "Webhooks"],
];

const METHOD_TONE: Record<string, string> = {
  GET: "bg-info-soft text-info",
  POST: "bg-ok-soft text-ok",
  PUT: "bg-warn-soft text-warn",
  PATCH: "bg-warn-soft text-warn",
  DELETE: "bg-bad-soft text-bad",
};

const ERRORS: Array<[string, ReactNode]> = [
  ["400", "The request isn't valid. The message says what to fix."],
  ["401", "The API key is missing, wrong or deleted."],
  ["403", "The key doesn't have the scope this endpoint needs (the message names it), or the endpoint is only for the app."],
  ["404", "Nothing with that id in this workspace."],
  ["409", "It clashes with something that already exists, such as a duplicate."],
  ["429", "Too many requests. Wait a moment and try again."],
  ["5xx", "Something went wrong on the server. Try again later."],
];

const slug = (s: string) => `api-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;

function C({ children }: { children: ReactNode }) {
  return <code className="rounded border border-line bg-panel px-1 py-px font-mono text-[12.5px] text-text">{children}</code>;
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="scroll-thin overflow-x-auto rounded-xl border border-transparent bg-[#0f1020] py-4 pl-4 pr-12 font-mono text-[12.5px] leading-relaxed text-[#d4d6f0] dark:border-line">{code}</pre>
      {/* A solid strip up to the edge, so a long line scrolling underneath doesn't show beside the button. */}
      <div className="absolute right-px top-px rounded-tr-xl bg-[#0f1020] pb-2 pl-1 pr-2 pt-[15px]">
        <CopyButton value={code} label="Copy" className="text-[#9a9cc0] hover:bg-[#23254a] hover:text-white" />
      </div>
    </div>
  );
}

function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4 space-y-4 text-[14.5px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function MethodBadge({ method }: { method: string }) {
  return <span className={cn("inline-flex w-16 shrink-0 justify-center rounded-md py-0.5 font-mono text-[11px] font-semibold", METHOD_TONE[method] ?? "bg-panel-2 text-muted")}>{method}</span>;
}

function Endpoints({ endpoints }: { endpoints: Endpoint[] }) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (e: Endpoint) => words.every((w) => `${e.method} ${e.path} ${e.summary} ${e.scope} ${e.group}`.toLowerCase().includes(w));
    const out = new Map<string, Endpoint[]>();
    for (const e of endpoints) if (match(e)) out.set(e.group, [...(out.get(e.group) ?? []), e]);
    return [...out];
  }, [endpoints, search]);
  const shown = groups.reduce((n, [, list]) => n + list.length, 0);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search endpoints" className="w-full sm:w-72" />
        <span className="text-[13px] text-faint">{search ? `${shown} of ${endpoints.length} endpoints` : `${endpoints.length} endpoints`}</span>
      </div>
      {groups.length === 0 ? (
        <EmptyState title="No endpoints match" description="Try a resource name, such as leads or webhooks, or part of a path." />
      ) : (
        groups.map(([group, list]) => (
          <div key={group} id={slug(group)} className="scroll-mt-24">
            <h3 className="mb-2 text-[15px] font-semibold text-text">{group}</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {list.map((e) => (
                <li key={`${e.method} ${e.path}`} className="flex items-start gap-3 px-4 py-3">
                  <MethodBadge method={e.method} />
                  <div className="min-w-0 flex-1">
                    <code className="block font-mono text-[13px] text-text [overflow-wrap:anywhere]">{e.path}</code>
                    <p className="mt-0.5 text-[13px] text-muted">{e.summary}</p>
                    <code className="mt-1 inline-block rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted sm:hidden">{e.scope}</code>
                  </div>
                  <code className="hidden shrink-0 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted sm:block">{e.scope}</code>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </>
  );
}

export default function Developers() {
  const brand = useBrand();
  const navigate = useNavigate();
  const ref = useQuery({ queryKey: ["api-reference"], queryFn: () => get<{ base_path: string; endpoints: Endpoint[] }>("/api/public/api-reference"), staleTime: 5 * 60_000 });
  const base = `${window.location.origin}${ref.data?.base_path ?? "/api/v2"}`;
  const groups = useMemo(() => [...new Set((ref.data?.endpoints ?? []).map((e) => e.group))], [ref.data]);
  const events = WEBHOOK_EVENT_TYPES.filter((t) => t !== "all_events");

  const nav = (
    <nav className="scroll-thin sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-6 text-[13px]">
      <p className="mb-2 font-semibold text-text">Guides</p>
      <ul className="space-y-1">
        {GUIDES.map(([id, label]) => (
          <li key={id}>
            <Link to={`#${id}`} className="block rounded-md py-1 text-muted hover:text-text">
              {label}
            </Link>
          </li>
        ))}
      </ul>
      <p className="mb-2 mt-6 font-semibold text-text">
        <Link to="#endpoints" className="hover:text-brand-text">
          Endpoints
        </Link>
      </p>
      <ul className="space-y-1">
        {groups.map((g) => (
          <li key={g}>
            <Link to={`#${slug(g)}`} className="block rounded-md py-1 text-muted hover:text-text">
              {g}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <MarketingLayout title="API reference">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:block">{nav}</aside>
        <div className="min-w-0 space-y-14">
          <header>
            <p className="text-[13px] font-semibold uppercase tracking-wider text-brand-text">Developers</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">API reference</h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
              Everything you do in {brand} you can also do from your own code: add leads, run campaigns, read and answer replies, manage email accounts. Requests and answers are JSON, and
              webhooks tell your systems the moment something happens.
            </p>
            {/* Phones have no sidebar, so the sections are one menu away. */}
            <NativeSelect
              className="mt-6 lg:hidden"
              aria-label="Jump to a section"
              value=""
              onChange={(id) => id && navigate(`#${id}`)}
              options={[
                { value: "", label: "Jump to…" },
                { group: "Guides", options: GUIDES.map(([value, label]) => ({ value, label })) },
                { group: "Endpoints", options: [{ value: "endpoints", label: "All endpoints" }, ...groups.map((g) => ({ value: slug(g), label: g }))] },
              ]}
            />
          </header>

          <DocSection id="getting-started" title="Getting started">
            <p>
              Create an API key in{" "}
              <Link to="/app/settings/integrations?tab=api" className="text-brand-text hover:underline">
                Settings → Integrations &amp; API
              </Link>
              . The key belongs to one workspace and is shown only once, so keep it somewhere safe. Every request goes to this address:
            </p>
            <CodeBlock code={base} />
            <p>For example, to list your first ten campaigns:</p>
            <CodeBlock code={`curl "${base}/campaigns?limit=10" \\\n  -H "Authorization: Bearer YOUR_API_KEY"`} />
            <p>And to add a lead to a campaign:</p>
            <CodeBlock
              code={`curl -X POST "${base}/leads" \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "campaign": "CAMPAIGN_ID",\n    "email": "jordan@example.com",\n    "first_name": "Jordan",\n    "company_name": "Example Co"\n  }'`}
            />
          </DocSection>

          <DocSection id="authentication" title="Authentication">
            <p>
              Send the key in the <C>Authorization</C> header of every request: <C>Authorization: Bearer YOUR_API_KEY</C>. A key only reaches the endpoints its scopes allow (see{" "}
              <Link to="#scopes" className="text-brand-text hover:underline">
                Scopes
              </Link>
              ). Delete a key in the same settings page and it stops working straight away.
            </p>
            <p>Keys are for servers. Don't put them in a web page or an app people can download.</p>
          </DocSection>

          <DocSection id="pagination" title="Pagination">
            <p>
              Endpoints that list things return one page at a time, as <C>{"{ items: [...], next_starting_after }"}</C>. Ask for up to 100 at once with <C>limit</C>. To get the next page, send
              the <C>next_starting_after</C> value back as <C>starting_after</C>. When it's <C>null</C>, you have everything.
            </p>
            <CodeBlock code={`curl "${base}/leads/list" -X POST \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "limit": 100, "starting_after": "NEXT_STARTING_AFTER" }'`} />
          </DocSection>

          <DocSection id="errors" title="Errors">
            <p>
              Anything that isn't a 2xx answer comes with a JSON body: <C>{"{ statusCode, error, message }"}</C>. The <C>message</C> is written for people, so it's fine to show it.
            </p>
            <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
              {ERRORS.map(([code, meaning]) => (
                <div key={code} className="flex gap-4 px-4 py-2.5">
                  <dt className="w-10 shrink-0 font-mono text-[13px] font-semibold text-text">{code}</dt>
                  <dd className="text-[13.5px]">{meaning}</dd>
                </div>
              ))}
            </dl>
          </DocSection>

          <DocSection id="scopes" title="Scopes">
            <p>
              A scope is <C>resource:action</C>, where the action is <C>create</C>, <C>read</C>, <C>update</C>, <C>delete</C> or <C>all</C>. A key with <C>leads:read</C> can read leads and
              nothing else; <C>campaigns:all</C> can do anything with campaigns; <C>all:read</C> can read everything; <C>all:all</C> is full access. Each endpoint below shows the scope it needs.
            </p>
            <p>Resources:</p>
            <ul className="flex flex-wrap gap-1.5">
              {API_SCOPE_RESOURCES.filter((r) => r !== "all").map((r) => (
                <li key={r}>
                  <C>{r}</C>
                </li>
              ))}
            </ul>
          </DocSection>

          <DocSection id="webhooks" title="Webhooks">
            <p>
              A webhook sends an event to your URL as it happens: a reply, a bounce, a lead marked interested. Add one in{" "}
              <Link to="/app/settings/integrations?tab=webhooks" className="text-brand-text hover:underline">
                Settings → Integrations &amp; API → Webhooks
              </Link>{" "}
              or with <C>POST /api/v2/webhooks</C>. Each one can listen to every event or one type, for all campaigns or one.
            </p>
            <p>
              Each event is a <C>POST</C> with a JSON body. Answer with any 2xx status within 15 seconds; redirects aren't followed. A failed delivery is tried again after 1 minute, 5 minutes,
              30 minutes, 2 hours and 6 hours. After 25 failures in a row the webhook is paused until you resume it. Every delivery is listed in <C>GET /api/v2/webhook-events</C>.
            </p>
            <CodeBlock
              code={`{\n  "timestamp": "2026-10-15T09:30:00.000Z",\n  "event_type": "reply_received",\n  "workspace": "WORKSPACE_ID",\n  "campaign_id": "CAMPAIGN_ID",\n  "campaign_name": "October outreach",\n  "email_account": "sales@yourdomain.com",\n  "lead_email": "jordan@example.com",\n  "firstName": "Jordan",\n  "companyName": "Example Co",\n  "step": 2,\n  "reply_subject": "Re: Quick question",\n  "reply_text_snippet": "Sounds good. Does Thursday work?",\n  "unibox_url": "${window.location.origin}/app/unibox?search=jordan%40example.com"\n}`}
            />
            <h3 className="pt-2 text-[15px] font-semibold text-text">Checking the signature</h3>
            <p>
              Turn on signing when you create the webhook and you get a secret, shown once. Every request then carries an <C>x-webhook-signature</C> header: <C>sha256=</C> followed by the
              HMAC-SHA256 of the raw request body, keyed with the secret, in hex. Compute it on your side and only trust requests that match.
            </p>
            <CodeBlock
              code={`import { createHmac, timingSafeEqual } from "node:crypto";\n\n// rawBody: the body exactly as it arrived, before any JSON parsing.\nfunction isSigned(rawBody, signatureHeader, secret) {\n  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");\n  const given = String(signatureHeader ?? "");\n  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));\n}`}
            />
            <h3 className="pt-2 text-[15px] font-semibold text-text">Event types</h3>
            <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {events.map((t) => (
                <li key={t} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line py-1.5">
                  <C>{t}</C>
                  <span className="text-[13px]">{WEBHOOK_EVENT_LABELS[t]}</span>
                </li>
              ))}
            </ul>
          </DocSection>

          <section id="endpoints" className="scroll-mt-24 space-y-6">
            <h2 className="text-2xl font-semibold tracking-tight">Endpoints</h2>
            {ref.isLoading ? (
              <div className="flex justify-center py-16">
                <Spinner />
              </div>
            ) : ref.isError || !ref.data ? (
              <EmptyState title="Couldn't load the endpoint list" description="The server didn't answer. Reload the page to try again." />
            ) : (
              <Endpoints endpoints={ref.data.endpoints} />
            )}
          </section>
        </div>
      </div>
    </MarketingLayout>
  );
}
