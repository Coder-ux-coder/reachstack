// Copilot memory: what the workspace sells and to whom, and how emails should be written. One record per
// workspace; Copilot reads it in every chat and AI Sales Agents can start from it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Brain, FileText, Globe, PenLine, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { Button, Callout, Card, Checkbox, Dialog, Field, Input, LinkTabs, NativeSelect, Section, Skeleton, SwitchRow, Textarea, useConfirm } from "@/components/ui";
import { api, del, errorMessage, get, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { useCan } from "@/lib/session";
import { useUnsavedChanges } from "@/lib/unsaved";
import { IcpDialog, type Icp } from "@/pages/app/agents/icp";

interface Memory {
  website?: string;
  company?: string;
  business_description?: string;
  business_offers?: string[];
  active_business_offers_indexes?: number[];
  awards?: string;
  outreach_goal?: string;
  icps?: Icp[];
  active_icps_indexes?: number[];
  custom_fields?: string[];
  predefined_rules?: { liquid_spintax?: boolean; default_language?: string | null; keep_short?: boolean };
}

interface MemoryData {
  memory: Memory | null;
  updated_at: string | null;
  updated_by: string | null;
}

interface Form {
  website: string;
  company: string;
  business_description: string;
  business_offers: string[];
  active_business_offers_indexes: number[];
  awards: string;
  outreach_goal: string;
  icps: Icp[];
  active_icps_indexes: number[];
  custom_fields: string[];
  liquid_spintax: boolean;
  default_language: string;
  keep_short: boolean;
}

const MEMORY_KEY = ["copilot-memory"] as const;
const MAX_RULES = 10;
const LANGUAGES = ["English", "Spanish", "French", "German", "Portuguese", "Italian", "Dutch", "Swedish", "Danish", "Norwegian", "Finnish", "Polish", "Czech", "Turkish", "Arabic", "Hebrew", "Hindi", "Japanese", "Korean", "Chinese"];

const TABS = [
  { slug: "business-details", label: "Business details" },
  { slug: "customer-profiles", label: "Customer profiles" },
  { slug: "guidance", label: "Guidance" },
] as const;

function toForm(m: Memory | null): Form {
  const offers = m?.business_offers ?? [];
  const icps = m?.icps ?? [];
  return {
    website: m?.website ?? "",
    company: m?.company ?? "",
    business_description: m?.business_description ?? "",
    business_offers: offers,
    active_business_offers_indexes: m?.active_business_offers_indexes ?? offers.map((_, i) => i),
    awards: m?.awards ?? "",
    outreach_goal: m?.outreach_goal ?? "",
    icps,
    active_icps_indexes: m?.active_icps_indexes ?? icps.map((_, i) => i),
    custom_fields: m?.custom_fields ?? [],
    liquid_spintax: !!m?.predefined_rules?.liquid_spintax,
    default_language: m?.predefined_rules?.default_language ?? "",
    keep_short: !!m?.predefined_rules?.keep_short,
  };
}

/** Blank offers and rules are dropped; ticked offers keep pointing at the same text. */
function fromForm(f: Form): Memory {
  const kept = f.business_offers.map((o, i) => ({ o: o.trim(), i })).filter((x) => x.o);
  return {
    website: f.website.trim(),
    company: f.company.trim(),
    business_description: f.business_description,
    business_offers: kept.map((x) => x.o),
    active_business_offers_indexes: kept.flatMap((x, j) => (f.active_business_offers_indexes.includes(x.i) ? [j] : [])),
    awards: f.awards,
    outreach_goal: f.outreach_goal,
    icps: f.icps,
    active_icps_indexes: f.active_icps_indexes,
    custom_fields: f.custom_fields.map((r) => r.trim()).filter(Boolean),
    predefined_rules: { liquid_spintax: f.liquid_spintax, default_language: f.default_language || null, keep_short: f.keep_short },
  };
}

/** Removing an item shifts the indexes after it. */
const dropIndex = (indexes: number[], i: number) => indexes.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));

function StartOption({ icon, title, description, children, onClick }: { icon: ReactNode; title: string; description: string; children?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-text">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium">{title}</p>
        <p className="mt-0.5 text-[13px] text-muted">{description}</p>
        {children}
      </div>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="flex w-full items-start gap-3 rounded-xl border border-line bg-panel p-4 text-left shadow-card transition-colors hover:border-line-strong hover:bg-panel-2">
      {body}
    </button>
  ) : (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-panel p-4 shadow-card">{body}</div>
  );
}

/** Reads the website or a document into a memory draft (nothing is saved until the user saves). */
function useLearn(onFilled: (m: Memory) => void) {
  const [busy, setBusy] = useState<"website" | "file" | null>(null);
  const website = async (url: string) => {
    setBusy("website");
    try {
      const r = await post<{ memory: Memory }>("/api/app/copilot/memory/extract/website", { url: url.trim() });
      onFilled(r.memory);
      toast.success("Read your website. Check the details, then save.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const file = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) {
      toast.error("The file must be smaller than 10 MB");
      return;
    }
    setBusy("file");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await api<{ memory: Memory }>("/api/app/copilot/memory/extract/file", { method: "POST", body: fd });
      onFilled(r.memory);
      toast.success(`Read ${f.name}. Check the details, then save.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, website, file };
}

function LearnSources({ onFilled, initialUrl = "" }: { onFilled: (m: Memory) => void; initialUrl?: string }) {
  const learn = useLearn(onFilled);
  const [url, setUrl] = useState(initialUrl);
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <StartOption icon={<Globe size={17} />} title="Learn from your website" description="Copilot reads your site and drafts your business details and customer profiles.">
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void learn.website(url);
          }}
        >
          <Input inputSize="sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourcompany.com" aria-label="Website" disabled={!!learn.busy} />
          <Button type="submit" size="sm" variant="primary" loading={learn.busy === "website"} disabled={!url.trim() || !!learn.busy}>
            Learn
          </Button>
        </form>
        {learn.busy === "website" && <p className="mt-2 text-xs text-muted">Reading the site. This can take up to a minute.</p>}
      </StartOption>
      <StartOption icon={<FileText size={17} />} title="Upload a document" description="A pitch deck, one-pager or sales notes as PDF or text (up to 10 MB).">
        <input
          ref={input}
          type="file"
          accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
          className="sr-only"
          aria-label="Choose a document"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void learn.file(f);
          }}
        />
        <Button size="sm" className="mt-3" icon={<Upload size={14} />} loading={learn.busy === "file"} disabled={!!learn.busy} onClick={() => input.current?.click()}>
          Choose a file
        </Button>
      </StartOption>
    </>
  );
}

/** Ways to fill an empty memory: read the website, read a document, or type it in. */
function StartScreen({ onFilled, onManual }: { onFilled: (m: Memory) => void; onManual: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-xl py-4">
      <div className="mb-5 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand-text">
          <Brain size={20} />
        </span>
        <h2 className="text-lg font-semibold">Teach Copilot about your business</h2>
        <p className="mt-1 text-[13px] text-muted">Copilot uses this in every chat to pick leads and write emails that fit. You can change it any time.</p>
      </div>
      <div className="space-y-3">
        <LearnSources onFilled={onFilled} />
        <StartOption icon={<PenLine size={17} />} title="Enter it yourself" description="Fill in the details by hand." onClick={onManual} />
      </div>
      <div className="mt-4 text-center">
        <Button variant="link" size="sm" onClick={() => navigate("/app/copilot")}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}

function LearnAgainDialog({ open, onOpenChange, website, onFilled }: { open: boolean; onOpenChange: (v: boolean) => void; website: string; onFilled: (m: Memory) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Learn again" description="Replaces the company, offers and customer profiles in the form. Rules and writing preferences stay. Nothing is saved until you save.">
      <div className="space-y-3">
        <LearnSources
          initialUrl={website}
          onFilled={(m) => {
            onFilled(m);
            onOpenChange(false);
          }}
        />
      </div>
    </Dialog>
  );
}

function BusinessDetails({ form, set, disabled }: { form: Form; set: (p: Partial<Form>) => void; disabled: boolean }) {
  const [newOffer, setNewOffer] = useState<number | null>(null);
  return (
    <>
      <Section title="Company">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name">{(id) => <Input id={id} value={form.company} onChange={(e) => set({ company: e.target.value })} disabled={disabled} maxLength={500} />}</Field>
            <Field label="Website" optional>
              {(id) => <Input id={id} value={form.website} onChange={(e) => set({ website: e.target.value })} disabled={disabled} maxLength={500} placeholder="https://yourcompany.com" />}
            </Field>
          </div>
          <Field label="What the business does" hint="Products, who they're for and what makes them different.">
            {(id) => <Textarea id={id} rows={6} value={form.business_description} onChange={(e) => set({ business_description: e.target.value })} disabled={disabled} maxLength={20_000} />}
          </Field>
        </div>
      </Section>
      <Section title="Offers" description="What you can offer prospects, such as an audit, a pilot or a demo. Copilot only mentions ticked offers.">
        <div className="space-y-2">
          {form.business_offers.map((o, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="pt-2.5">
                <Checkbox
                  checked={form.active_business_offers_indexes.includes(i)}
                  disabled={disabled}
                  onChange={(v) => set({ active_business_offers_indexes: v ? [...form.active_business_offers_indexes, i].sort((x, y) => x - y) : form.active_business_offers_indexes.filter((x) => x !== i) })}
                  aria-label={`Use offer ${i + 1}`}
                />
              </span>
              <Textarea
                rows={2}
                value={o}
                autoFocus={i === newOffer}
                disabled={disabled}
                onChange={(e) => set({ business_offers: form.business_offers.map((x, j) => (j === i ? e.target.value : x)) })}
                aria-label={`Offer ${i + 1}`}
                placeholder="A free 20-minute audit of their onboarding"
                maxLength={2_000}
              />
              {!disabled && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="mt-1.5"
                  aria-label={`Remove offer ${i + 1}`}
                  onClick={() => set({ business_offers: form.business_offers.filter((_, j) => j !== i), active_business_offers_indexes: dropIndex(form.active_business_offers_indexes, i) })}
                >
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          ))}
          {!form.business_offers.length && <p className="text-[13px] text-muted">No offers yet.</p>}
          {!disabled && (
            <Button
              size="sm"
              icon={<Plus size={14} />}
              disabled={form.business_offers.length >= 20}
              onClick={() => {
                setNewOffer(form.business_offers.length);
                set({ business_offers: [...form.business_offers, ""], active_business_offers_indexes: [...form.active_business_offers_indexes, form.business_offers.length] });
              }}
            >
              Add offer
            </Button>
          )}
        </div>
      </Section>
      <Section title="More context">
        <div className="space-y-4">
          <Field label="Awards and recognition" optional hint="Only real ones: Copilot may mention them in emails.">
            {(id) => <Textarea id={id} rows={2} value={form.awards} onChange={(e) => set({ awards: e.target.value })} disabled={disabled} maxLength={5_000} />}
          </Field>
          <Field label="Outreach goal" optional>
            {(id) => <Input id={id} value={form.outreach_goal} onChange={(e) => set({ outreach_goal: e.target.value })} disabled={disabled} maxLength={2_000} placeholder="Book demos with operations leaders" />}
          </Field>
        </div>
      </Section>
    </>
  );
}

function CustomerProfiles({ form, set, disabled }: { form: Form; set: (p: Partial<Form>) => void; disabled: boolean }) {
  const [edit, setEdit] = useState<{ icp: Icp; index: number | null } | null>(null);
  return (
    <Section title="Ideal customer profiles" description="Who you sell to. Copilot builds lead lists and writes for the ticked profiles. Up to 10.">
      <div className="space-y-2">
        {form.icps.map((icp, i) => {
          const active = form.active_icps_indexes.includes(i);
          const bits = [icp.job_title?.include?.slice(0, 3).join(", "), icp.location?.slice(0, 2).join(", "), icp.industry?.slice(0, 2).join(", "), icp.company_size?.length ? `${icp.company_size.join(", ")} employees` : null].filter(Boolean);
          return (
            <Card key={i} className={cn("flex items-start gap-3", !active && "opacity-70")}>
              <span className="pt-0.5">
                <Checkbox
                  checked={active}
                  disabled={disabled}
                  onChange={(v) => set({ active_icps_indexes: v ? [...form.active_icps_indexes, i].sort((x, y) => x - y) : form.active_icps_indexes.filter((x) => x !== i) })}
                  aria-label={`Use ${icp.name}`}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{icp.name}</p>
                <p className="mt-0.5 truncate text-xs text-muted">{bits.join(" · ") || "Any role, place, industry and size"}</p>
                {icp.problems_solved?.length ? <p className="mt-1 line-clamp-2 text-xs text-faint">Solves: {icp.problems_solved.join("; ")}</p> : null}
              </div>
              {!disabled && (
                <div className="flex shrink-0 gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${icp.name}`} onClick={() => setEdit({ icp, index: i })}>
                    <Pencil size={14} />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${icp.name}`} onClick={() => set({ icps: form.icps.filter((_, j) => j !== i), active_icps_indexes: dropIndex(form.active_icps_indexes, i) })}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
        {!form.icps.length && <p className="text-[13px] text-muted">No profiles yet. Add one so Copilot knows who to look for.</p>}
        {!disabled && (
          <Button size="sm" icon={<Plus size={14} />} disabled={form.icps.length >= 10} onClick={() => setEdit({ icp: { name: "" }, index: null })}>
            Add profile
          </Button>
        )}
      </div>
      <IcpDialog
        value={edit}
        targeting
        description="Copilot uses each ticked profile to suggest leads and shape emails."
        onClose={() => setEdit(null)}
        onSave={(icp, index) =>
          index === null ? set({ icps: [...form.icps, icp], active_icps_indexes: [...form.active_icps_indexes, form.icps.length] }) : set({ icps: form.icps.map((x, j) => (j === index ? icp : x)) })
        }
      />
    </Section>
  );
}

function Guidance({ form, set, disabled }: { form: Form; set: (p: Partial<Form>) => void; disabled: boolean }) {
  const [newRule, setNewRule] = useState<number | null>(null);
  return (
    <>
      <Section title="Writing preferences">
        <div className="divide-y divide-line">
          <SwitchRow label="Use spintax and fallbacks" description="Emails vary their wording ({{RANDOM | Hi | Hey}}) and fall back when a variable is empty ({{firstName | there}})." checked={form.liquid_spintax} onChange={(v) => set({ liquid_spintax: v })} disabled={disabled} />
          <SwitchRow label="Keep emails short" description="Under 90 words per email." checked={form.keep_short} onChange={(v) => set({ keep_short: v })} disabled={disabled} />
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium">Email language</p>
              <p className="mt-0.5 text-[13px] text-muted">Language for emails Copilot writes, unless you ask for another.</p>
            </div>
            <NativeSelect
              className="w-48"
              aria-label="Email language"
              value={form.default_language}
              disabled={disabled}
              onChange={(v) => set({ default_language: v })}
              options={[{ value: "", label: "Same as the chat" }, ...LANGUAGES.map((l) => ({ value: l, label: l }))]}
            />
          </div>
        </div>
      </Section>
      <Section title="Rules" description={`Instructions Copilot follows in every chat, for example “Never mention pricing in a first email”. Up to ${MAX_RULES}.`}>
        <div className="space-y-2">
          {form.custom_fields.map((r, i) => (
            <div key={i} className="flex items-start gap-2">
              <Textarea
                rows={2}
                value={r}
                autoFocus={i === newRule}
                disabled={disabled}
                maxLength={2_000}
                aria-label={`Rule ${i + 1}`}
                placeholder="Always end with a yes-or-no question"
                onChange={(e) => set({ custom_fields: form.custom_fields.map((x, j) => (j === i ? e.target.value : x)) })}
              />
              {!disabled && (
                <Button size="icon-sm" variant="ghost" className="mt-1.5" aria-label={`Remove rule ${i + 1}`} onClick={() => set({ custom_fields: form.custom_fields.filter((_, j) => j !== i) })}>
                  <Trash2 size={14} />
                </Button>
              )}
            </div>
          ))}
          {!form.custom_fields.length && <p className="text-[13px] text-muted">No rules yet.</p>}
          {!disabled && (
            <Button
              size="sm"
              icon={<Plus size={14} />}
              disabled={form.custom_fields.length >= MAX_RULES}
              onClick={() => {
                setNewRule(form.custom_fields.length);
                set({ custom_fields: [...form.custom_fields, ""] });
              }}
            >
              Add rule
            </Button>
          )}
        </div>
      </Section>
    </>
  );
}

export function CopilotMemory() {
  usePageTitle("Copilot memory");
  const { tab = "business-details" } = useParams();
  const can = useCan();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: MEMORY_KEY, queryFn: () => get<MemoryData>("/api/app/copilot/memory") });
  const baseline = useMemo(() => toForm(q.data?.memory ?? null), [q.data]);
  const [form, setForm] = useState(baseline);
  const [manual, setManual] = useState(false);
  const [relearn, setRelearn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(baseline), [baseline]);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !busy, undefined, "/app/copilot/memory/");
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const editable = can.perm("edit_campaigns") && can.write;

  if (!TABS.some((t) => t.slug === tab)) return <Navigate to="/app/copilot/memory/business-details" replace />;

  const save = async () => {
    setBusy(true);
    try {
      const r = await put<{ memory: Memory; updated_at: string }>("/api/app/copilot/memory", { memory: fromForm(form) });
      queryClient.setQueryData<MemoryData>(MEMORY_KEY, (d) => ({ memory: r.memory, updated_at: r.updated_at, updated_by: d?.updated_by ?? null }));
      void queryClient.invalidateQueries({ queryKey: MEMORY_KEY });
      toast.success("Memory saved. Copilot uses it in new chats.");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!(await confirm({ title: "Clear Copilot's memory?", description: "Business details, customer profiles and rules are deleted for everyone in this workspace.", confirmLabel: "Clear memory", danger: true }))) return;
    try {
      await del("/api/app/copilot/memory");
      setManual(false);
      await queryClient.invalidateQueries({ queryKey: MEMORY_KEY });
      toast.success("Memory cleared");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const empty = !q.data?.memory;
  const starting = empty && !manual && !dirty;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Memory</h1>
              <p className="mt-1 text-[13px] text-muted">
                What Copilot knows about your business. Shared with everyone in this workspace.
                {q.data?.updated_at && (
                  <span className="text-faint">
                    {" "}
                    Updated {ago(q.data.updated_at)}
                    {q.data.updated_by ? ` by ${q.data.updated_by}` : ""}.
                  </span>
                )}
              </p>
            </div>
            {!starting && !q.isLoading && editable && (
              <div className="flex gap-1.5">
                <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => setRelearn(true)}>
                  Learn again
                </Button>
                {!empty && (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={clear}>
                    Clear memory
                  </Button>
                )}
              </div>
            )}
          </div>
          {q.isLoading ? (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : q.isError ? (
            <Callout tone="bad" className="mt-6" title="Couldn't load the memory">
              {errorMessage(q.error)}
            </Callout>
          ) : starting ? (
            editable ? (
              <StartScreen
                onFilled={(m) => {
                  setForm(toForm(m));
                  setManual(true);
                }}
                onManual={() => setManual(true)}
              />
            ) : (
              <Callout tone="info" className="mt-6">
                Copilot doesn't know about this business yet. Someone who can edit campaigns can teach it here.
              </Callout>
            )
          ) : (
            <>
              <LinkTabs className="mt-4" tabs={TABS.map((t) => ({ to: `/app/copilot/memory/${t.slug}`, label: t.label }))} />
              <div className="pb-6">
                {tab === "business-details" && <BusinessDetails form={form} set={set} disabled={!editable} />}
                {tab === "customer-profiles" && <CustomerProfiles form={form} set={set} disabled={!editable} />}
                {tab === "guidance" && <Guidance form={form} set={set} disabled={!editable} />}
              </div>
            </>
          )}
        </div>
      </div>
      <LearnAgainDialog
        open={relearn}
        onOpenChange={setRelearn}
        website={form.website}
        onFilled={(m) => {
          const next = toForm(m);
          setForm((f) => ({ ...next, awards: f.awards, outreach_goal: f.outreach_goal, custom_fields: f.custom_fields, liquid_spintax: f.liquid_spintax, default_language: f.default_language, keep_short: f.keep_short }));
        }}
      />
      {editable && (dirty || (manual && empty)) && (
        <div className="shrink-0 border-t border-line bg-bg">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-end gap-2 px-4 py-3 sm:px-6">
            <span className="mr-auto text-[13px] text-muted">{empty ? "Not saved yet" : "Unsaved changes"}</span>
            <Button
              disabled={busy}
              onClick={() => {
                setForm(baseline);
                if (empty) setManual(false);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" loading={busy} disabled={!dirty || (!form.company.trim() && !form.business_description.trim())} onClick={save}>
              Save memory
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
