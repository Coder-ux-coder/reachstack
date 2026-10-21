import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Globe, Mail, Plus, RefreshCcw, Trash2, Upload, X } from "lucide-react";
import { del, errorMessage, get, post, put } from "@/lib/api";
import { todayIn } from "@/lib/dates";
import { ago, dateOnly, downloadBlob, num, plural } from "@/lib/format";
import { useDebounced, usePageTitle } from "@/lib/hooks";
import { useCan, useWorkspaceZone } from "@/lib/session";
import { useLeadStatuses } from "@/lib/statuses";
import { Badge, Button, Callout, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, SearchInput, Segmented, SwitchRow, TagInput, Textarea, useConfirm } from "@/components/ui";
import { SettingsHeader } from "./parts";

interface Entry {
  id: string;
  bl_value: string;
  is_domain: boolean;
  source: string | null;
  timestamp_created: string;
}

interface BlockSettings {
  add_unsub_to_block: boolean;
  sheet_link: string | null;
  sheet_synced_at: string | null;
  sheet_error: string | null;
  triggers: { statuses: number[]; phrases: string[] };
}

const SOURCE: Record<string, string> = { manual: "Added by hand", unsubscribe: "Unsubscribed", api: "API", sheet: "Google Sheet", trigger: "Trigger", csv: "CSV" };

function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"manual" | "csv" | "sheet">("manual");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<string[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setText("");
      setRows(null);
      setFileName("");
      setUrl("");
    }
  }, [open]);

  const values = mode === "manual" ? text.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean) : (rows ?? []);
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "sheet") {
        const r = await post<{ found: number; added: number }>("/api/app/blocklist/sheet", { url: url.trim() });
        toast.success(`Found ${plural(r.found, "row")} · ${plural(r.added, "new entry", "new entries")}. The sheet is re-read daily.`);
      } else {
        let added = 0;
        let invalid = 0;
        for (let i = 0; i < values.length; i += 10_000) {
          const r = await post<{ created_count: number; invalid_count: number }>("/api/v2/block-lists-entries/bulk-create", { bl_values: values.slice(i, i + 10_000) });
          added += r.created_count;
          invalid += r.invalid_count;
        }
        toast.success(`${num(added)} added${invalid ? ` · ${num(invalid)} skipped as invalid` : ""}`);
      }
      await qc.invalidateQueries({ queryKey: ["blocklist"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add to blocklist"
      description="Blocked addresses and domains are never emailed, and are skipped when leads are imported."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={mode === "sheet" ? !/docs\.google\.com\/spreadsheets/.test(url) : !values.length} onClick={submit}>
            {mode === "sheet" ? "Link sheet" : `Add ${values.length ? num(values.length) : ""}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "manual", label: "Type or paste" },
            { value: "csv", label: "CSV file" },
            { value: "sheet", label: "Google Sheet" },
          ]}
        />
        {mode === "manual" && <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={"jane@competitor.com\ncompetitor.com\n@another-domain.com"} aria-label="Emails or domains, one per line" />}
        {mode === "csv" && (
          <div className="space-y-2">
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                if (f.size > 5 * 1024 * 1024) return toast.error("Upload a file under 5 MB");
                setFileName(f.name);
                Papa.parse<string[]>(f, {
                  skipEmptyLines: true,
                  complete: (r) => setRows(blockColumn(r.data)),
                });
              }}
            />
            <button type="button" onClick={() => file.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-xl border border-dashed border-line-strong px-4 py-8 text-[13px] text-muted hover:border-brand hover:text-brand-text">
              <Upload size={18} />
              {fileName ? `${fileName} · ${plural(rows?.length ?? 0, "value")} found` : "Choose a CSV with emails or domains"}
            </button>
          </div>
        )}
        {mode === "sheet" && (
          <div className="space-y-2">
            <Field label="Google Sheets link" hint="One column of emails or domains. Share it as 'Anyone with the link can view' and keep it that way; it's re-read every day.">
              {(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />}
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN = /^@?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/**
 * The values to block from a CSV: the column with the most email addresses (or, without any, the most domains), so a
 * name, phone number or website next to them isn't taken instead. A header row is passed over.
 */
function blockColumn(rows: string[][]): string[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const count = (test: RegExp, col: number) => rows.filter((r) => test.test((r[col] ?? "").trim())).length;
  const best = (test: RegExp) => Array.from({ length: width }, (_, col) => ({ col, n: count(test, col) })).sort((a, b) => b.n - a.n)[0];
  const byEmail = best(EMAIL);
  const pick = byEmail && byEmail.n > 0 ? byEmail : best(DOMAIN);
  if (!pick || pick.n === 0) return [];
  const test = pick === byEmail ? EMAIL : DOMAIN;
  return rows.map((r) => (r[pick.col] ?? "").trim()).filter((v) => test.test(v));
}

function TriggersCard({ settings, writable }: { settings: BlockSettings; writable: boolean }) {
  const qc = useQueryClient();
  const statuses = useLeadStatuses();
  const [codes, setCodes] = useState<number[]>(settings.triggers.statuses);
  const [phrases, setPhrases] = useState<string[]>(settings.triggers.phrases);
  const dirty = JSON.stringify(codes) !== JSON.stringify(settings.triggers.statuses) || JSON.stringify(phrases) !== JSON.stringify(settings.triggers.phrases);
  const save = async () => {
    try {
      await put("/api/app/blocklist/settings", { triggers: { statuses: codes, phrases } });
      await qc.invalidateQueries({ queryKey: ["blocklist-settings"] });
      toast.success("Triggers saved");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card>
      <CardHeader title="Automatic blocking" description="Block a lead's address the moment one of these happens." />
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium">When a lead is marked as</p>
          <div className="flex flex-wrap gap-1.5">
            {statuses.all.map((s) => {
              const on = codes.includes(s.code);
              return (
                <button
                  key={s.code}
                  type="button"
                  disabled={!writable}
                  onClick={() => setCodes(on ? codes.filter((c) => c !== s.code) : [...codes, s.code])}
                  aria-pressed={on}
                  className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-brand bg-brand-soft text-brand-text" : "border-line text-muted hover:border-line-strong"}`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
        <Field label="Or when a reply contains" hint="Any of these phrases in what the lead wrote (your quoted email doesn't count). Not case-sensitive.">
          {(id) => <TagInput id={id} value={phrases} onChange={setPhrases} placeholder="remove me; take me off" disabled={!writable} />}
        </Field>
        {writable && dirty && (
          <Button size="sm" variant="primary" onClick={save}>
            Save triggers
          </Button>
        )}
      </div>
    </Card>
  );
}

/** /app/settings/blocklist */
export default function Blocklist() {
  usePageTitle("Blocklist");
  const qc = useQueryClient();
  const can = useCan();
  const zone = useWorkspaceZone();
  const confirm = useConfirm();
  const writable = can.perm("blocklist") && can.write;
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [kind, setKind] = useState<"all" | "domains">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const settings = useQuery({ queryKey: ["blocklist-settings"], queryFn: () => get<BlockSettings>("/api/app/blocklist/settings") });
  const list = useInfiniteQuery({
    queryKey: ["blocklist", q, kind],
    queryFn: ({ pageParam }) => get<{ items: Entry[]; next_starting_after?: string | null; total?: number }>("/api/v2/block-lists-entries", { limit: 100, search: q || undefined, domains_only: kind === "domains" || undefined, starting_after: pageParam, with_total: !pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_starting_after ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  useEffect(() => setSelected(new Set()), [q, kind]);

  const removeSelected = async () => {
    if (!(await confirm({ title: `Remove ${selected.size} ${selected.size === 1 ? "entry" : "entries"}?`, description: "These addresses and domains can be emailed again.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await post("/api/v2/block-lists-entries/bulk-delete", { ids: [...selected] });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["blocklist"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const download = async () => {
    try {
      const res = await fetch("/api/v2/block-lists-entries/download", { credentials: "same-origin" });
      if (!res.ok) throw new Error("The download failed");
      downloadBlob(`blocklist-${todayIn(zone)}.csv`, await res.blob());
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const s = settings.data;

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Blocklist"
        description="Addresses and domains this workspace never emails. Leads on it are skipped at import and before every send."
        actions={
          writable && (
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add
            </Button>
          )
        }
      />

      {s && (
        <Card>
          <SwitchRow
            label="Block people who unsubscribe"
            description="Anyone who clicks unsubscribe or replies asking to stop is added here."
            checked={s.add_unsub_to_block}
            onChange={async (v) => {
              await put("/api/app/blocklist/settings", { add_unsub_to_block: v }).catch((e) => toast.error(errorMessage(e)));
              qc.invalidateQueries({ queryKey: ["blocklist-settings"] });
            }}
            disabled={!writable}
          />
          {s.sheet_link && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[13px]">
              <FileSpreadsheet size={15} className="text-ok" />
              <a href={s.sheet_link} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate text-brand-text hover:underline">
                Linked Google Sheet
              </a>
              <span className="text-xs text-muted">{s.sheet_error ? <span className="text-bad">{s.sheet_error}</span> : s.sheet_synced_at ? `read ${ago(s.sheet_synced_at)}` : ""}</span>
              {writable && (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<RefreshCcw size={12} />}
                    onClick={async () => {
                      try {
                        const r = await post<{ added: number }>("/api/app/blocklist/sheet", { url: s.sheet_link });
                        toast.success(`${num(r.added)} new entries`);
                        qc.invalidateQueries({ queryKey: ["blocklist"] });
                        qc.invalidateQueries({ queryKey: ["blocklist-settings"] });
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  >
                    Read now
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Unlink sheet"
                    onClick={async () => {
                      await del("/api/app/blocklist/sheet").catch((e) => toast.error(errorMessage(e)));
                      qc.invalidateQueries({ queryKey: ["blocklist-settings"] });
                    }}
                  >
                    <X size={13} />
                  </Button>
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {s && <TriggersCard key={JSON.stringify(s.triggers)} settings={s} writable={writable} />}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search emails or domains" className="w-full sm:w-64" />
          <Segmented
            size="sm"
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: "All" },
              { value: "domains", label: "Domains" },
            ]}
          />
          <span className="text-[13px] text-muted">{total !== undefined ? `${num(total)} ${total === 1 ? "entry" : "entries"}` : ""}</span>
          <div className="ml-auto flex gap-2">
            {writable && selected.size > 0 && (
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={removeSelected}>
                Remove {selected.size}
              </Button>
            )}
            <Button size="sm" icon={<Download size={14} />} onClick={download}>
              Download
            </Button>
          </div>
        </div>
        {settings.isError && <Callout tone="bad">The blocklist couldn't be loaded.</Callout>}
        <div className="divide-y divide-line">
          {rows.map((e) => (
            <div key={e.id} className="flex items-center gap-3 px-4 py-2">
              {writable && (
                <Checkbox
                  checked={selected.has(e.id)}
                  onChange={(v) =>
                    setSelected((cur) => {
                      const n = new Set(cur);
                      if (v) n.add(e.id);
                      else n.delete(e.id);
                      return n;
                    })
                  }
                  aria-label={`Select ${e.bl_value}`}
                />
              )}
              {e.is_domain ? <Globe size={14} className="text-faint" /> : <Mail size={14} className="text-faint" />}
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{e.bl_value}</span>
              {e.source && <Badge>{SOURCE[e.source] ?? e.source}</Badge>}
              <span className="hidden w-24 text-right text-xs text-muted sm:block">{dateOnly(e.timestamp_created)}</span>
            </div>
          ))}
        </div>
        {!list.isLoading && !rows.length && <EmptyState className="py-10" icon={<Mail size={20} />} title={q ? "Nothing matches" : "The blocklist is empty"} description={q ? undefined : "Add competitors, existing customers, or anyone who shouldn't hear from you."} />}
        {list.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      <AddDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}
