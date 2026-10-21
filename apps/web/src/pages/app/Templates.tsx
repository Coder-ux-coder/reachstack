import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Copy, FilePlus2, FileText, MessageSquareReply, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { htmlToText, validateBraces } from "@reachstack/shared";
import { del, errorMessage, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { usePageTitle, useQueryState } from "@/lib/hooks";
import { deletedToast, restorable } from "@/lib/recently-deleted";
import { useCan } from "@/lib/session";
import { RichEditor } from "@/components/RichEditor";
import { EmailFrame } from "@/components/EmailFrame";
import { VariablesMenu, useTemplateLibrary, useTemplates, type TemplateItem } from "@/components/sequence/tools";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, MenuItem, RowMenu, SearchInput, SkeletonRows, Tabs, useConfirm } from "@/components/ui";

type Tab = "email" | "reply" | "library";

const preview = (html: string) => htmlToText(html).replace(/\s+/g, " ").trim();

function TemplateDialog({ open, onOpenChange, template, reply, categories }: { open: boolean; onOpenChange: (v: boolean) => void; template: Partial<TemplateItem> | null; reply: boolean; categories: string[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const editing = !!template?.id && !template.is_library;
  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? "");
    setCategory(template?.category ?? "");
    setSubject(template?.subject ?? "");
    setBody(template?.body ?? "");
  }, [open, template]);
  const braces = validateBraces(`${subject}\n${body}`);
  const save = async () => {
    setBusy(true);
    try {
      const payload = { name: name.trim(), category: category.trim() || null, subject: reply ? "" : subject, body, is_reply_template: reply };
      if (editing) await patch(`/api/app/templates/${template!.id}`, payload);
      else await post("/api/app/templates", payload);
      await qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success(editing ? "Template saved" : "Template created");
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
      size="lg"
      title={editing ? "Edit template" : reply ? "New reply template" : "New email template"}
      description={reply ? "Reply templates are inserted from the Unibox composer." : "Email templates can be dropped into any sequence step."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !preview(body) || !!braces} onClick={save}>
            {editing ? "Save" : "Create template"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus placeholder="Short intro, ops leaders" />}</Field>
          <Field label="Category" optional>
            {(id) => (
              <>
                <Input id={id} list="tpl-categories" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} placeholder="Follow-ups" />
                <datalist id="tpl-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </div>
        {!reply && <Field label="Subject">{(id) => <Input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="{{firstName}}, quick question" />}</Field>}
        <Field label="Body" error={braces}>
          {() => (
            <RichEditor
              value={body}
              onChange={setBody}
              minHeight={220}
              placeholder="Write the email. Variables like {{firstName}} are filled in per lead."
              toolbarExtra={<VariablesMenu onInsert={(t) => setBody((b) => `${b}${b.endsWith(">") || !b ? "" : " "}${t}`)} />}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function PreviewDialog({ template, onClose, onCopy, onUse }: { template: TemplateItem | null; onClose: () => void; onCopy?: () => void; onUse?: () => void }) {
  return (
    <Dialog
      open={!!template}
      onOpenChange={(v) => !v && onClose()}
      size="lg"
      title={template?.name ?? ""}
      description={template?.category ?? undefined}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {onCopy && (
            <Button icon={<Copy size={14} />} onClick={onCopy}>
              Save to my templates
            </Button>
          )}
          {onUse && (
            <Button variant="primary" icon={<Send size={14} />} onClick={onUse}>
              Use in a new campaign
            </Button>
          )}
        </>
      }
    >
      {template && (
        <div className="space-y-3">
          {template.subject && (
            <p className="text-sm">
              <span className="text-muted">Subject: </span>
              <span className="font-medium">{template.subject}</span>
            </p>
          )}
          <div className="rounded-lg border border-line px-3 py-2.5">
            <EmailFrame html={template.body} minHeight={200} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** /app/templates — saved email and reply templates, plus the built-in library. */
export default function Templates() {
  usePageTitle("Templates");
  const can = useCan();
  const nav = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [tab, setTab] = useQueryState("tab", "email");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [editing, setEditing] = useState<Partial<TemplateItem> | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewing, setViewing] = useState<TemplateItem | null>(null);
  const t = (tab as Tab) || "email";
  const mineEmail = useTemplates("email");
  const mineReply = useTemplates("reply");
  const library = useTemplateLibrary();
  const source = t === "library" ? library : t === "reply" ? mineReply : mineEmail;
  const categories = source.data?.categories ?? [];
  useEffect(() => setCategory(""), [tab]);
  const items = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (source.data?.items ?? []).filter((x) => (!category || x.category === category) && (!s || `${x.name} ${x.subject} ${preview(x.body)}`.toLowerCase().includes(s)));
  }, [source.data, search, category]);
  const canEdit = t === "reply" ? can.perm("unibox") : can.write && can.perm("edit_campaigns");

  const open = (x: Partial<TemplateItem> | null) => {
    setEditing(x);
    setDialogOpen(true);
  };
  const duplicate = async (x: TemplateItem) => {
    try {
      if (x.is_library) await post("/api/app/templates", { name: x.name, subject: x.subject, body: x.body, category: x.category, is_reply_template: false });
      else await post(`/api/app/templates/${x.id}/duplicate`);
      await qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success(x.is_library ? "Saved to your templates" : "Template duplicated");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (x: TemplateItem) => {
    if (!(await confirm({ title: `Delete "${x.name}"?`, description: `Sequences that already use its text keep it. ${restorable()}`, confirmLabel: "Delete", danger: true }))) return;
    try {
      const r = await del<{ recently_deleted_id?: string }>(`/api/app/templates/${x.id}`);
      await qc.invalidateQueries({ queryKey: ["templates"] });
      deletedToast("Template deleted", r.recently_deleted_id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  /** Starts a draft campaign whose first step is this template. */
  const startCampaign = async (x: TemplateItem) => {
    try {
      const c = await post<{ id: string }>("/api/app/campaigns", { name: x.name });
      await patch(`/api/v2/campaigns/${c.id}`, { sequences: [{ steps: [{ type: "email", delay: 0, variants: [{ subject: x.subject, body: x.body }] }] }] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      nav(`/app/campaign/${c.id}/sequences`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const counts = { email: mineEmail.data?.items.length, reply: mineReply.data?.items.length, library: library.data?.items.length };
  const tabLabel = (label: string, n: number | undefined) => (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {n !== undefined && <span className="rounded-full bg-panel-2 px-1.5 text-[11px] tabular-nums text-muted">{n}</span>}
    </span>
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Templates</h1>
          <p className="mt-1 text-[13px] text-muted">Reusable emails for sequences and quick replies for the Unibox.</p>
        </div>
        {t !== "library" && canEdit && (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => open(null)}>
            New template
          </Button>
        )}
      </div>
      <Tabs
        className="mt-5"
        value={t}
        onChange={(v) => setTab(v)}
        tabs={[
          { value: "email", label: tabLabel("Email templates", counts.email) },
          { value: "reply", label: tabLabel("Reply templates", counts.reply) },
          { value: "library", label: tabLabel("Library", counts.library) },
        ]}
      />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search templates" className="w-64" />
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {["", ...categories].map((c) => (
              <button
                key={c || "all"}
                type="button"
                onClick={() => setCategory(c)}
                className={cn("rounded-full border px-3 py-1 text-xs", category === c ? "border-brand bg-brand-soft font-medium text-brand-text" : "border-line text-muted hover:text-text")}
              >
                {c || "All"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        {source.isLoading ? (
          <Card padded={false}>
            <SkeletonRows rows={4} />
          </Card>
        ) : !items.length ? (
          <Card>
            <EmptyState
              icon={t === "reply" ? <MessageSquareReply size={22} /> : t === "library" ? <BookOpen size={22} /> : <FileText size={22} />}
              title={search || category ? "No templates match" : t === "reply" ? "No reply templates yet" : "No email templates yet"}
              description={
                search || category
                  ? undefined
                  : t === "reply"
                    ? "Save answers you send often (pricing, booking links, case studies) and insert them from the Unibox."
                    : "Save a step from any sequence, write one here, or start from the library."
              }
              action={
                !search &&
                !category &&
                canEdit && (
                  <>
                    <Button variant="primary" icon={<Plus size={15} />} onClick={() => open(null)}>
                      New template
                    </Button>
                    {t === "email" && <Button onClick={() => setTab("library")}>Browse the library</Button>}
                  </>
                )
              }
            />
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((x) => (
              <Card key={x.id} padded={false} className="flex flex-col">
                <button type="button" onClick={() => setViewing(x)} className="flex-1 p-4 text-left">
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold">{x.name}</p>
                    {x.category && <Badge>{x.category}</Badge>}
                  </div>
                  {x.subject && <p className="mt-2 truncate text-[13px] font-medium">{x.subject}</p>}
                  <p className="mt-1 line-clamp-3 text-[13px] text-muted">{preview(x.body) || "—"}</p>
                </button>
                <div className="flex items-center gap-1 border-t border-line px-3 py-2">
                  {x.is_library ? (
                    <>
                      <Button size="xs" variant="ghost" icon={<FilePlus2 size={13} />} disabled={!canEdit} onClick={() => duplicate(x)}>
                        Save to mine
                      </Button>
                      <Button size="xs" variant="ghost" icon={<Pencil size={13} />} disabled={!canEdit} onClick={() => open({ ...x, id: undefined, is_library: false })}>
                        Customise
                      </Button>
                    </>
                  ) : (
                    canEdit && (
                      <Button size="xs" variant="ghost" icon={<Pencil size={13} />} onClick={() => open(x)}>
                        Edit
                      </Button>
                    )
                  )}
                  <div className="ml-auto">
                    <RowMenu>
                      {t !== "reply" && can.write && can.perm("edit_campaigns") && (
                        <MenuItem icon={<Send size={14} />} onSelect={() => startCampaign(x)}>
                          Use in a new campaign
                        </MenuItem>
                      )}
                      {!x.is_library && canEdit && (
                        <MenuItem icon={<Copy size={14} />} onSelect={() => duplicate(x)}>
                          Duplicate
                        </MenuItem>
                      )}
                      {!x.is_library && canEdit && (
                        <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => remove(x)}>
                          Delete
                        </MenuItem>
                      )}
                      {x.is_library && (
                        <MenuItem icon={<FileText size={14} />} onSelect={() => setViewing(x)}>
                          Preview
                        </MenuItem>
                      )}
                    </RowMenu>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <TemplateDialog open={dialogOpen} onOpenChange={setDialogOpen} template={editing} reply={t === "reply"} categories={(t === "reply" ? mineReply : mineEmail).data?.categories ?? []} />
      <PreviewDialog
        template={viewing}
        onClose={() => setViewing(null)}
        onCopy={viewing?.is_library && canEdit ? () => viewing && duplicate(viewing).then(() => setViewing(null)) : undefined}
        onUse={viewing && t !== "reply" && can.write && can.perm("edit_campaigns") ? () => viewing && startCampaign(viewing) : undefined}
      />
    </div>
  );
}

