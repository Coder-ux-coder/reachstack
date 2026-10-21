// Website visitors → Setup: terms, domains and their snippet, the installation test, the IP lookup token, and
// each domain's ideal customer profile and ignored pages.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Code2, FlaskConical, KeyRound, Plus, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { INDUSTRIES, REVENUE_BANDS } from "@reachstack/shared";
import { del, errorMessage, patch, post, put } from "@/lib/api";
import { ago, dateOnly, dateTime } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useBrand, useCan, useSession } from "@/lib/session";
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  CopyButton,
  DataTable,
  Dialog,
  Field,
  Input,
  MenuItem,
  MenuSeparator,
  RowMenu,
  SkeletonRows,
  TagInput,
  Tooltip,
  useConfirm,
  type Column,
} from "@/components/ui";
import { invalidateVisitors, useSites, type Icp, type VisitorSite } from "./api";
import { EMPLOYEE_OPTIONS, MultiPick } from "./dialogs";

function TestStatus({ s }: { s: VisitorSite }) {
  if (s.conflict) {
    return (
      <Tooltip content="Another visitor snippet with a different key is on this site. Remove one: only the first snippet on a page reports visits.">
        <Badge tone="bad">Snippet conflict</Badge>
      </Tooltip>
    );
  }
  if (s.test_status === "successful") {
    return (
      <Tooltip content={s.last_event_at ? `Last event ${dateTime(s.last_event_at)}` : "The snippet was found on your homepage"}>
        <Badge tone="ok" dot>
          Successful
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Tooltip content="Test the installation to make sure the snippet is working.">
      <Badge tone="neutral">Not tested</Badge>
    </Tooltip>
  );
}

function CodeDialog({ site, onClose }: { site: VisitorSite | null; onClose: () => void }) {
  return (
    <Dialog open={!!site} onOpenChange={(v) => !v && onClose()} size="lg" title="Install the snippet" description={site ? `Add this to every page of ${site.domain}.` : undefined}>
      {site && <SnippetSteps site={site} />}
    </Dialog>
  );
}

function SnippetSteps({ site }: { site: VisitorSite }) {
  const me = useSession();
  return (
    <>
      {!me.features.tracking_reachable && (
        <Callout tone="warn" className="mb-4">
          This server can't be reached from the internet, so the snippet can't report visits from your site's visitors. Run the app on a server with a
          public address, then install the snippet from there.
        </Callout>
      )}
      <ol className="space-y-4 text-[13px]">
        <li>
          <p className="font-medium">1. Copy the snippet</p>
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-panel-2 p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{site.snippet}</code>
            <CopyButton value={site.snippet} />
          </div>
        </li>
        <li>
          <p className="font-medium">2. Paste it into your site</p>
          <p className="mt-1 text-muted">
            Put it just before <code className="font-mono text-xs">&lt;/head&gt;</code> in your site's template, or add it as a Custom HTML tag that fires on all pages in your tag manager. Website builders
            usually have a "custom code" or "header scripts" setting for this.
          </p>
        </li>
        <li>
          <p className="font-medium">3. Test it</p>
          <p className="mt-1 text-muted">
            Open{" "}
            <a className="text-brand-text hover:underline" href={`https://${site.domain}/?wv_test=1`} target="_blank" rel="noreferrer noopener">
              {site.domain}/?wv_test=1
            </a>{" "}
            in your browser, then press "Test code installation". The snippet skips browsers that send Do Not Track or Global Privacy Control, so test from one that doesn't.
          </p>
        </li>
      </ol>
    </>
  );
}

function SiteSettingsDialog({ site, onClose }: { site: VisitorSite | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [icp, setIcp] = useState<Icp>({});
  const [exclude, setExclude] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (site) {
      setIcp(site.settings.icp ?? {});
      setExclude(site.settings.exclude_paths ?? []);
    }
  }, [site]);
  const save = async () => {
    if (!site) return;
    setBusy(true);
    try {
      await patch(`/api/app/website-visitors/sites/${site.id}`, { icp, exclude_paths: exclude });
      await invalidateVisitors(qc);
      toast.success("Domain settings saved");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!site}
      onOpenChange={(v) => !v && onClose()}
      size="lg"
      title={site ? `${site.domain} settings` : ""}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <h3 className="text-[13px] font-semibold">Ideal customer profile</h3>
          <p className="mb-3 text-xs text-muted">Companies that match every field you fill in get a star in the visitor list, and views can be limited to them.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Industries">{(id) => <MultiPick id={id} options={INDUSTRIES} value={icp.industries ?? []} onChange={(v) => setIcp({ ...icp, industries: v })} searchable />}</Field>
            <Field label="Employees">{(id) => <MultiPick id={id} options={EMPLOYEE_OPTIONS} value={icp.employees ?? []} onChange={(v) => setIcp({ ...icp, employees: v })} />}</Field>
            <Field label="Revenue">{(id) => <MultiPick id={id} options={REVENUE_BANDS} value={icp.revenue ?? []} onChange={(v) => setIcp({ ...icp, revenue: v })} />}</Field>
            <Field label="Countries">{(id) => <TagInput id={id} value={icp.countries ?? []} onChange={(v) => setIcp({ ...icp, countries: v })} placeholder="United States, Canada" />}</Field>
          </div>
        </div>
        <Field label="Ignore visits to these pages" hint='Path prefixes, like /admin or /account/*. Useful for logged-in areas and your own team.'>
          {(id) => <TagInput id={id} value={exclude} onChange={setExclude} placeholder="/admin, /account/*" />}
        </Field>
      </div>
    </Dialog>
  );
}

function LookupCard({ source, workspaceSet, serverSet }: { source: "workspace" | "server" | null; workspaceSet: boolean; serverSet: boolean }) {
  const qc = useQueryClient();
  const can = useCan();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const save = async (value: string | null) => {
    setBusy(value ? "save" : "remove");
    try {
      await put("/api/app/website-visitors/lookup", { token: value });
      setToken("");
      await invalidateVisitors(qc);
      toast.success(value ? "Token saved. Waiting visits will be identified within a minute." : "Token removed");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Company lookup"
        description="Visits are matched to companies with an IP lookup service (ipinfo.io). Plans that include company data identify the most visitors; with others, only networks registered to a company in your lead data are matched."
      />
      <div className="space-y-3 text-[13px]">
        {source === "workspace" && (
          <Callout tone="ok" title="Using this workspace's token">
            Lookups count against your ipinfo plan.
          </Callout>
        )}
        {source === "server" && (
          <Callout tone="ok" title="Using this server's token">
            The server's administrator set one up{workspaceSet ? "" : ". You can use your own instead"}.
          </Callout>
        )}
        {!source && (
          <Callout tone="warn" title="No lookup token yet">
            Visits are recorded and wait up to 30 days to be identified.
          </Callout>
        )}
        {can.admin ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={workspaceSet ? "Replace this workspace's token" : "ipinfo access token"} className="min-w-0 flex-1 basis-56">
              {(id) => <Input id={id} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token from your ipinfo dashboard" />}
            </Field>
            <Button variant="primary" icon={<KeyRound size={14} />} loading={busy === "save"} disabled={!token.trim()} onClick={() => void save(token.trim())}>
              Check and save
            </Button>
            {workspaceSet && (
              <Button variant="ghost" loading={busy === "remove"} onClick={() => void save(null)}>
                Remove{serverSet ? " (use the server's)" : ""}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted">Only owners and admins can change the lookup token.</p>
        )}
      </div>
    </Card>
  );
}

export function VisitorSetup() {
  usePageTitle("Website visitors setup");
  const brand = useBrand();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useSites();
  const [domain, setDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState<VisitorSite | null>(null);
  const [settings, setSettings] = useState<VisitorSite | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<Record<string, { status: string; detail: string }>>({});

  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.isError || !q.data) return <Callout tone="bad">{errorMessage(q.error)}</Callout>;
  const { items, terms, lookup } = q.data;

  const add = async () => {
    setAdding(true);
    try {
      const site = await post<VisitorSite>("/api/app/website-visitors/sites", { domain: domain.trim() });
      setDomain("");
      await invalidateVisitors(qc);
      setCode(site);
      toast.success(`${site.domain} added`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const test = async (s: VisitorSite) => {
    setTesting(s.id);
    try {
      const r = await post<{ status: "receiving" | "installed" | "not_found" | "unreachable"; detail: string }>(`/api/app/website-visitors/sites/${s.id}/test`);
      setLastTest((m) => ({ ...m, [s.id]: r }));
      if (r.status === "receiving" || r.status === "installed") toast.success(r.detail);
      else toast.warning(r.detail);
      await invalidateVisitors(qc);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (s: VisitorSite) => {
    const ok = await confirm({
      title: `Delete the domain "${s.domain}"?`,
      description: "Its recorded visits and the views limited to it are deleted. The snippet on your site stops reporting.",
      confirmLabel: "Delete domain",
      danger: true,
      typeToConfirm: s.domain,
    });
    if (!ok) return;
    try {
      await del(`/api/app/website-visitors/sites/${s.id}`);
      await invalidateVisitors(qc);
      toast.success("Domain deleted");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<VisitorSite>[] = [
    { key: "domain", header: "Domain", cell: (s) => <span className="font-medium">{s.domain}</span> },
    { key: "created", header: "Created", hideBelow: "sm", cell: (s) => <span className="text-muted">{dateOnly(s.created_at)}</span> },
    {
      key: "status",
      header: "Test status",
      cell: (s) => (
        <div className="space-y-1">
          <TestStatus s={s} />
          {s.last_event_at && <p className="text-xs text-muted">Last visit {ago(s.last_event_at)}</p>}
          {lastTest[s.id] && lastTest[s.id]!.status !== "receiving" && lastTest[s.id]!.status !== "installed" && <p className="max-w-xs text-xs text-warn">{lastTest[s.id]!.detail}</p>}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "text-right",
      cell: (s) => (
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" icon={<FlaskConical size={14} />} loading={testing === s.id} disabled={!can.write} onClick={() => void test(s)} aria-label="Test code installation">
            <span className="hidden sm:inline">Test code installation</span>
            <span className="sm:hidden">Test</span>
          </Button>
          <RowMenu label={`${s.domain} actions`}>
            <MenuItem icon={<Code2 size={14} />} onSelect={() => setCode(s)}>
              See code
            </MenuItem>
            {can.write && (
              <>
                <MenuItem icon={<Settings2 size={14} />} onSelect={() => setSettings(s)}>
                  Profile and ignored pages
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => void remove(s)}>
                  Delete domain
                </MenuItem>
              </>
            )}
          </RowMenu>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {!terms.accepted ? (
        <Callout
          tone="warn"
          title="Accept the website visitor terms to get started"
          action={
            <ButtonLink size="sm" variant="primary" to={`/user/sign-website-visitor-tos?next=${encodeURIComponent("/app/website-visitors/setup")}`}>
              {can.admin ? "Review terms" : "View terms"}
            </ButtonLink>
          }
        >
          {can.admin ? "They cover how the snippet tracks visits and what you tell your site's visitors." : "A workspace owner or admin needs to accept them before domains can be added."}
        </Callout>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck size={13} className="text-ok" />
          Terms accepted{terms.accepted_by ? ` by ${terms.accepted_by}` : ""}
          {terms.accepted_at ? ` on ${dateOnly(terms.accepted_at)}` : ""}.{" "}
          <Link to="/user/sign-website-visitor-tos" className="text-brand-text hover:underline">
            Read them
          </Link>
        </p>
      )}

      <Card padded={false}>
        <div className="p-5 pb-4">
          <CardHeader className="mb-0" title="Domains" description={`Each domain gets its own snippet. Subdomains (www, app, blog) report to their parent domain.`} />
          {can.write && terms.accepted && (
            <form
              className="mt-4 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (domain.trim()) void add();
              }}
            >
              <Input className="min-w-0 flex-1 sm:max-w-sm" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" aria-label="Domain" inputMode="url" />
              <Button type="submit" variant="primary" icon={<Plus size={14} />} loading={adding} disabled={!domain.trim()}>
                Add domain
              </Button>
            </form>
          )}
        </div>
        <DataTable
          className="rounded-none border-x-0 border-b-0 shadow-none"
          rows={items}
          columns={columns}
          rowKey={(s) => s.id}
          empty={<p className="px-4 py-10 text-center text-[13px] text-muted">Configure a domain to get started.</p>}
        />
      </Card>

      {items.length === 1 && items[0]!.test_status !== "successful" && (
        <Card>
          <CardHeader title={`Install the snippet on ${items[0]!.domain}`} />
          <SnippetSteps site={items[0]!} />
        </Card>
      )}

      <LookupCard source={lookup.source} workspaceSet={lookup.workspace_token_set} serverSet={lookup.server_token_set} />

      <Card>
        <CardHeader title="Privacy" />
        <ul className="space-y-2 text-[13px] text-muted">
          <li className="flex gap-2">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
            The snippet sets no cookies. It keeps a random ID in the browser's local storage to group pages into visits, and stays off when the browser sends Do Not Track or Global Privacy Control.
          </li>
          <li className="flex gap-2">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
            Identification is company-level only. {brand} never identifies the person browsing; best contacts are suggestions from your lead data.
          </li>
          <li className="flex gap-2">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
            IP addresses are sent to the lookup service and deleted once looked up, or after 30 days if they never are.
          </li>
          <li className="flex gap-2">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" />
            Mention visitor analytics in your privacy notice, and load the snippet only after consent where the law requires it (for example in the EU and UK).
          </li>
        </ul>
      </Card>

      <CodeDialog site={code} onClose={() => setCode(null)} />
      <SiteSettingsDialog site={settings} onClose={() => setSettings(null)} />
    </div>
  );
}
