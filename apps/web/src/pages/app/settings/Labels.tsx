import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Plus, Sparkles, Tag as TagIcon, Tags, Trash2 } from "lucide-react";
import { DEFAULT_INTEREST_STATUSES } from "@reachstack/shared";
import { del, errorMessage, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useLeadStatuses, type LeadLabel } from "@/lib/statuses";
import type { Tag } from "@/lib/types";
import { TAGS_KEY, useTags } from "@/components/TagPicker";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, MenuItem, RowMenu, SearchInput, Segmented, SkeletonRows, SwitchRow, Textarea, useConfirm } from "@/components/ui";
import { SettingsHeader } from "./parts";

const SWATCHES = ["#4f46e5", "#0ea5e9", "#14b8a6", "#16a34a", "#ca8a04", "#ea580c", "#dc2626", "#db2777", "#9333ea", "#64748b"];

function ColorChoice({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Colour">
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={cn("h-6 w-6 rounded-full ring-offset-2 ring-offset-panel transition", value === c ? "ring-2 ring-text" : "hover:scale-110")}
          style={{ background: c }}
        />
      ))}
      <button type="button" role="radio" aria-checked={!value} onClick={() => onChange(null)} className={cn("ml-1 rounded-md px-2 py-0.5 text-xs", !value ? "bg-panel-2 font-medium" : "text-muted hover:text-text")}>
        Default
      </button>
    </div>
  );
}

const SENTIMENT = {
  positive: { label: "Positive", tone: "ok" as const },
  neutral: { label: "Neutral", tone: "neutral" as const },
  negative: { label: "Negative", tone: "bad" as const },
};
type Sentiment = keyof typeof SENTIMENT;

function Dot({ color }: { color: string }) {
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

function LabelDialog({ open, onOpenChange, label }: { open: boolean; onOpenChange: (v: boolean) => void; label: LeadLabel | null }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [sentiment, setSentiment] = useState<Sentiment>("positive");
  const [description, setDescription] = useState("");
  const [ai, setAi] = useState(true);
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(label?.label ?? "");
    setSentiment(label?.interest_status_label ?? "positive");
    setDescription(label?.description ?? "");
    setAi(label ? label.use_with_ai : true);
    setColor(label?.color ?? null);
  }, [open, label]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = { label: name.trim(), description: description.trim() || null, use_with_ai: ai, color };
      if (label) await patch(`/api/v2/lead-labels/${label.id}`, payload);
      else await post("/api/v2/lead-labels", { ...payload, interest_status_label: sentiment });
      toast.success(label ? "Label updated" : "Label created");
      qc.invalidateQueries({ queryKey: ["lead-statuses"] });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={label ? "Edit label" : "New lead label"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="label-form" variant="primary" loading={busy} disabled={!name.trim()}>
            {label ? "Save" : "Create label"}
          </Button>
        </>
      }
    >
      <form id="label-form" onSubmit={submit} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Asked for pricing" autoFocus />}</Field>
        <Field label="Counts as" hint={label ? "This can't be changed once a label exists." : "Decides whether it shows up as a win in reports and the CRM."}>
          {() =>
            label ? (
              <Badge tone={SENTIMENT[sentiment].tone}>{SENTIMENT[sentiment].label}</Badge>
            ) : (
              <Segmented size="sm" value={sentiment} onChange={setSentiment} options={(Object.keys(SENTIMENT) as Sentiment[]).map((s) => ({ value: s, label: SENTIMENT[s].label }))} />
            )
          }
        </Field>
        <Field label="Description" hint="When a reply deserves this label. Automatic labelling reads this, so be specific.">
          {(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="The lead asks what it costs or requests a quote." />}
        </Field>
        <SwitchRow label="Use for automatic labelling" description="Replies can be given this label without anyone reading them first." checked={ai} onChange={setAi} />
        <Field label="Colour">{() => <ColorChoice value={color} onChange={setColor} />}</Field>
      </form>
    </Dialog>
  );
}

/** /app/settings/lead-labels */
export default function LeadLabels() {
  usePageTitle("Lead labels");
  const can = useCan();
  const editable = can.write && can.perm("leads");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const statuses = useLeadStatuses();
  const [editing, setEditing] = useState<LeadLabel | null>(null);
  const [open, setOpen] = useState(false);
  const custom = statuses.all.filter((s) => s.custom);
  const edit = (l: LeadLabel | null) => {
    setEditing(l);
    setOpen(true);
  };
  const remove = async (l: LeadLabel) => {
    if (!(await confirm({ title: `Delete "${l.label}"?`, description: "Leads with this label go back to having no status. Webhooks and filters that use it stop matching.", confirmLabel: "Delete label", danger: true }))) return;
    try {
      await del(`/api/v2/lead-labels/${l.id}`);
      toast.success("Label deleted");
      qc.invalidateQueries({ queryKey: ["lead-statuses"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Lead labels"
        description="Labels record where a lead stands after they reply. Add your own alongside the built-in ones; each counts as positive, neutral or negative in reports."
        actions={
          editable && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => edit(null)}>
              New label
            </Button>
          )
        }
      />

      <Card padded={false}>
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">Your labels</h2>
        </div>
        {statuses.isLoading ? (
          <SkeletonRows rows={3} />
        ) : !custom.length ? (
          <EmptyState
            icon={<Tags size={22} />}
            title="No custom labels yet"
            description="For example “Asked for pricing” or “Referred a colleague”. They appear in the Unibox, the CRM and webhook events."
            action={
              editable && (
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => edit(null)}>
                  New label
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {custom.map((s) => {
              const l = s.custom!;
              return (
                <li key={l.id} className="flex items-start gap-3 px-5 py-3">
                  <span className="mt-1.5">
                    <Dot color={s.color} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{l.label}</span>
                      <Badge tone={SENTIMENT[l.interest_status_label].tone}>{SENTIMENT[l.interest_status_label].label}</Badge>
                      {l.use_with_ai && (
                        <Badge tone="brand">
                          <Sparkles size={11} /> Automatic
                        </Badge>
                      )}
                    </div>
                    {l.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{l.description}</p>}
                  </div>
                  {editable && (
                    <RowMenu>
                      <MenuItem icon={<Pencil size={14} />} onSelect={() => edit(l)}>
                        Edit
                      </MenuItem>
                      <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => remove(l)}>
                        Delete
                      </MenuItem>
                    </RowMenu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card padded={false}>
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">Built-in labels</h2>
          <p className="text-xs text-muted">Always available and can't be changed.</p>
        </div>
        <ul className="grid gap-x-6 px-5 py-2 sm:grid-cols-2">
          {DEFAULT_INTEREST_STATUSES.map((s) => (
            <li key={s.code} className="flex items-center gap-2.5 py-2 text-[13px]">
              <Dot color={s.color} />
              <span className="flex-1">{s.label}</span>
              <span className="text-xs text-faint">{SENTIMENT[s.sentiment].label}</span>
            </li>
          ))}
        </ul>
      </Card>

      <LabelDialog open={open} onOpenChange={setOpen} label={editing} />
    </div>
  );
}

function TagDialog({ open, onOpenChange, tag }: { open: boolean; onOpenChange: (v: boolean) => void; tag: Tag | null }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(tag?.label ?? "");
    setDescription(tag?.description ?? "");
    setColor(tag?.color ?? null);
  }, [open, tag]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = { label: name.trim(), description: description.trim() || null, color };
      if (tag) await patch(`/api/v2/custom-tags/${tag.id}`, payload);
      else await post("/api/v2/custom-tags", payload);
      toast.success(tag ? "Tag updated" : "Tag created");
      qc.invalidateQueries({ queryKey: TAGS_KEY });
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tag ? "Edit tag" : "New tag"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="tag-form" variant="primary" loading={busy} disabled={!name.trim()}>
            {tag ? "Save" : "Create tag"}
          </Button>
        </>
      }
    >
      <form id="tag-form" onSubmit={submit} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Client: Northwind" autoFocus />}</Field>
        <Field label="Description" hint="Optional.">
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />}
        </Field>
        <Field label="Colour">{() => <ColorChoice value={color} onChange={setColor} />}</Field>
      </form>
    </Dialog>
  );
}

/** /app/settings/custom-tags */
export function CustomTags() {
  usePageTitle("Custom tags");
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const tags = useTags();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Tag | null>(null);
  const [open, setOpen] = useState(false);
  const shown = (tags.data ?? []).filter((t) => t.label.toLowerCase().includes(search.trim().toLowerCase()));
  const edit = (t: Tag | null) => {
    setEditing(t);
    setOpen(true);
  };
  const remove = async (t: Tag) => {
    if (!(await confirm({ title: `Delete "${t.label}"?`, description: "It's removed from every email account and campaign. Campaigns that pick senders by this tag stop using it.", confirmLabel: "Delete tag", danger: true }))) return;
    try {
      await del(`/api/v2/custom-tags/${t.id}`);
      toast.success("Tag deleted");
      qc.invalidateQueries({ queryKey: TAGS_KEY });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Custom tags"
        description="Group email accounts and campaigns, for example by client or domain. Filter lists by tag, and let a campaign send from every account with a tag."
        actions={
          can.write && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => edit(null)}>
              New tag
            </Button>
          )
        }
      />
      <Card padded={false}>
        <div className="border-b border-line p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search tags" className="max-w-xs" />
        </div>
        {tags.isLoading ? (
          <SkeletonRows rows={3} />
        ) : !shown.length ? (
          <EmptyState
            icon={<TagIcon size={22} />}
            title={search ? "No tags match" : "No tags yet"}
            description={search ? undefined : "You can also create tags while tagging accounts or campaigns."}
            action={
              !search &&
              can.write && (
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => edit(null)}>
                  New tag
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                <Dot color={t.color || "var(--faint)"} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.label}</p>
                  {t.description && <p className="truncate text-[13px] text-muted">{t.description}</p>}
                </div>
                {can.write && (
                  <RowMenu>
                    <MenuItem icon={<Pencil size={14} />} onSelect={() => edit(t)}>
                      Edit
                    </MenuItem>
                    <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => remove(t)}>
                      Delete
                    </MenuItem>
                  </RowMenu>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <TagDialog open={open} onOpenChange={setOpen} tag={editing} />
    </div>
  );
}
