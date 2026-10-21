import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, ChevronDown, Clock, Paperclip, Send, X } from "lucide-react";
import { AccountStatus, htmlToText, isValidEmailSyntax, renderTemplate, writtenEmailVariables, type LeadLike } from "@reachstack/shared";
import { api, errorMessage, get, post, type Page } from "@/lib/api";
import { dateTime, humanizeTimestamps } from "@/lib/format";
import { useWorkspaceZone } from "@/lib/session";
import type { Account } from "@/lib/types";
import { RichEditor, type RichEditorHandle } from "@/components/RichEditor";
import { TemplatesPicker } from "@/components/sequence/tools";
import { Button, Dialog, Input, Popover, Select, TagInput, useConfirm } from "@/components/ui";
import { useUnsavedChanges } from "@/lib/unsaved";
import { SEND_LATER_PRESETS, senderHint, toLocalInput } from "@/pages/app/unibox/shared";

interface Upload {
  id: string;
  filename: string;
  size: number;
}

/** The mailbox last used for a new email, per browser. */
const FROM_KEY = "compose.from";
const rememberedFrom = () => {
  try {
    return localStorage.getItem(FROM_KEY) ?? "";
  } catch {
    return "";
  }
};

/**
 * "New email": starts a conversation rather than replying to one. Opened from the Unibox, the lead panel and the CRM;
 * with a lead, templates fill in that lead's details.
 */
export function NewEmailDialog({ open, onOpenChange, to: initialTo, lead }: { open: boolean; onOpenChange: (v: boolean) => void; to?: string[]; lead?: LeadLike | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const accounts = useQuery({
    queryKey: ["accounts", "picker"],
    queryFn: () => get<Page<Account>>("/api/v2/accounts", { limit: 1000, include_tags: true }),
    select: (d) => d.items,
    enabled: open,
  });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [laterAt, setLaterAt] = useState(() => toLocalInput(SEND_LATER_PRESETS[1]!.at()));
  const editor = useRef<RichEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fid = useId();
  const confirm = useConfirm();

  // Closing it (Esc, a click outside, the X, Cancel) or leaving the page asks before what was written is thrown away.
  const written = !!subject.trim() || !!htmlToText(body).trim() || uploads.length > 0;
  useUnsavedChanges(open && written, "This email hasn't been sent.");
  const close = async () => {
    if (sending) return;
    if (written && !(await confirm({ title: "Discard this email?", description: "What you've written isn't saved anywhere.", confirmLabel: "Discard", cancelLabel: "Keep writing", danger: true }))) return;
    onOpenChange(false);
  };

  // A fresh draft each time it opens, addressed to whoever it was opened for.
  useEffect(() => {
    if (!open) return;
    setTo((initialTo ?? []).map((x) => x.toLowerCase()));
    setCc([]);
    setBcc([]);
    setShowCc(false);
    setSubject("");
    setBody("");
    setUploads([]);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only a paused mailbox can't send. One with a problem is tried, and if it fails the error says what went wrong.
  const usable = (accounts.data ?? []).filter((a) => a.status !== AccountStatus.PAUSED);
  useEffect(() => {
    if (!open || from || !accounts.data) return;
    const remembered = rememberedFrom();
    setFrom(usable.find((a) => a.email === remembered)?.email ?? usable.find((a) => a.status === AccountStatus.ACTIVE)?.email ?? usable[0]?.email ?? "");
  }, [open, accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const account = accounts.data?.find((a) => a.email === from);
  const zone = useWorkspaceZone();
  const fromOptions = (accounts.data ?? []).map((a) => ({
    value: a.email,
    label: `${a.first_name} ${a.last_name}`.trim() ? `${`${a.first_name} ${a.last_name}`.trim()} <${a.email}>` : a.email,
    hint: senderHint(a.status),
    disabled: a.status === AccountStatus.PAUSED,
  }));

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of Array.from(files)) {
      if (f.size > 25 * 1024 * 1024) {
        toast.error(`"${f.name}" is too large. Attachments can be up to 25 MB.`);
        return;
      }
      fd.append("file", f, f.name);
    }
    setUploading(true);
    try {
      const r = await api<{ files: Upload[] }>("/api/app/uploads", { method: "POST", body: fd });
      setUploads((u) => [...u, ...r.files]);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const applyTemplate = (t: { subject: string; body: string }) => {
    const vars = writtenEmailVariables(lead ?? { email: to[0] ?? null }, { email: from, first_name: account?.first_name, last_name: account?.last_name, signature: account?.signature }, zone);
    const render = (text: string, html: boolean) => renderTemplate(text, vars, { escapeHtml: html, keepUnresolved: true });
    const b = render(t.body, true);
    const s = render(t.subject ?? "", false);
    if (b.warnings.length || s.warnings.length) toast.warning("Template added. Some variables had no lead data, so check the text before sending.");
    if (!subject.trim() && s.output.trim()) setSubject(s.output);
    if (htmlToText(body).trim()) editor.current?.insertText(b.output);
    else setBody(b.output);
  };

  const send = async (scheduledAt?: Date) => {
    if (uploading) return toast.error("Wait for the attachment to finish uploading.");
    if (!from) return toast.error("Choose a mailbox to send from.");
    if (!to.length) return toast.error("Add at least one recipient.");
    if (!subject.trim()) return toast.error("Add a subject.");
    if (!htmlToText(body).trim() && !uploads.length) return toast.error("Write a message first.");
    setSending(true);
    try {
      const r = await post<{ id: string; thread_id: string }>("/api/v2/emails/send", {
        eaccount: from,
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject: subject.trim(),
        body: { html: body },
        attachment_ids: uploads.map((u) => u.id),
        scheduled_at: scheduledAt?.toISOString(),
      });
      try {
        localStorage.setItem(FROM_KEY, from);
      } catch {
        // Remembering the mailbox is only a convenience.
      }
      qc.invalidateQueries({ queryKey: ["unibox"] });
      const folder = scheduledAt ? "scheduled" : "sent";
      toast.success(scheduledAt ? `Scheduled for ${dateTime(scheduledAt)}` : "Email sent", {
        action: { label: "Open", onClick: () => navigate(`/app/unibox?folder=${folder}&thread=${r.thread_id}`) },
      });
      onOpenChange(false);
    } catch (e) {
      toast.error(humanizeTimestamps(errorMessage(e)));
    } finally {
      setSending(false);
    }
  };

  const valid = (v: string) => isValidEmailSyntax(v);
  const row = "flex items-start gap-2";
  const label = "mt-2 w-14 shrink-0 text-muted";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => (v ? onOpenChange(true) : void close())}
      size="lg"
      title="New email"
      description="Starts a new conversation. Their reply shows up in the Unibox."
      footer={
        <>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
          <Button variant="ghost" icon={<Paperclip size={14} />} loading={uploading} onClick={() => fileInput.current?.click()} className="mr-auto">
            {uploading ? "Uploading…" : "Attach"}
          </Button>
          <Button onClick={() => void close()} disabled={sending}>
            Cancel
          </Button>
          <div className="inline-flex">
            {/* Nothing goes out while an attachment is still uploading: it would be left off. */}
            <Button variant="primary" icon={<Send size={14} />} loading={sending} disabled={uploading} onClick={() => send()} className="rounded-r-none">
              Send
            </Button>
            <Popover
              open={laterOpen}
              onOpenChange={setLaterOpen}
              align="end"
              className="w-72"
              trigger={
                <Button variant="primary" aria-label="Send later" disabled={sending || uploading} className="rounded-l-none border-l border-white/25 px-2">
                  <ChevronDown size={14} />
                </Button>
              }
            >
              <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
                <CalendarClock size={14} /> Send later
              </p>
              <div className="space-y-1">
                {SEND_LATER_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-panel-2"
                    onClick={() => {
                      setLaterOpen(false);
                      send(p.at());
                    }}
                  >
                    {p.label}
                    <span className="text-xs text-faint">{dateTime(p.at())}</span>
                  </button>
                ))}
              </div>
              <div className="mt-2 border-t border-line pt-2">
                <Input inputSize="sm" type="datetime-local" value={laterAt} onChange={(e) => setLaterAt(e.target.value)} aria-label="Send at" />
                <Button
                  size="sm"
                  className="mt-2 w-full"
                  icon={<Clock size={13} />}
                  onClick={() => {
                    const at = new Date(laterAt);
                    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) return toast.error("Choose a time at least a minute from now.");
                    setLaterOpen(false);
                    send(at);
                  }}
                >
                  Schedule send
                </Button>
              </div>
            </Popover>
          </div>
        </>
      }
    >
      <div className="space-y-2 text-[13px]">
        <div className={row}>
          <span className={label}>From</span>
          <Select
            size="sm"
            className="min-w-0 flex-1"
            value={from}
            onChange={setFrom}
            placeholder={accounts.isLoading ? "Loading…" : "No mailboxes connected yet"}
            options={fromOptions}
            aria-label="From"
          />
        </div>
        <div className={row}>
          <label htmlFor={`${fid}-to`} className={label}>
            To
          </label>
          <TagInput id={`${fid}-to`} value={to} onChange={(v) => setTo(v.map((x) => x.toLowerCase()))} validate={valid} placeholder="name@company.com" className="min-h-8 min-w-0 flex-1 py-1" />
          {!showCc && (
            <button type="button" className="mt-2 shrink-0 text-xs text-muted hover:text-text" onClick={() => setShowCc(true)}>
              Cc/Bcc
            </button>
          )}
        </div>
        {showCc && (
          <>
            <div className={row}>
              <label htmlFor={`${fid}-cc`} className={label}>
                Cc
              </label>
              <TagInput id={`${fid}-cc`} value={cc} onChange={(v) => setCc(v.map((x) => x.toLowerCase()))} validate={valid} className="min-h-8 min-w-0 flex-1 py-1" />
            </div>
            <div className={row}>
              <label htmlFor={`${fid}-bcc`} className={label}>
                Bcc
              </label>
              <TagInput id={`${fid}-bcc`} value={bcc} onChange={(v) => setBcc(v.map((x) => x.toLowerCase()))} validate={valid} className="min-h-8 min-w-0 flex-1 py-1" />
            </div>
          </>
        )}
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-muted">Subject</span>
          <Input inputSize="sm" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" className="min-w-0 flex-1" autoFocus={!!initialTo?.length} />
        </div>
        <RichEditor
          ref={editor}
          value={body}
          onChange={setBody}
          placeholder="Write your email…"
          minHeight={180}
          className="mt-3"
          toolbarExtra={<TemplatesPicker onPick={(t) => applyTemplate(t)} />}
        />
        {!!uploads.length && (
          <div className="flex flex-wrap gap-2 pt-1">
            {uploads.map((u) => (
              <span key={u.id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs">
                <Paperclip size={12} className="text-faint" />
                <span className="max-w-[14rem] truncate">{u.filename}</span>
                <button type="button" aria-label={`Remove ${u.filename}`} className="hit-24 text-faint hover:text-bad" onClick={() => setUploads(uploads.filter((x) => x.id !== u.id))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
