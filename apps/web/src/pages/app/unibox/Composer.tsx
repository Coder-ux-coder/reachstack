import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, ChevronDown, Clock, Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { AccountStatus, CampaignStatus, htmlToText, isValidEmailSyntax, renderTemplate, writtenEmailVariables } from "@reachstack/shared";
import { api, errorMessage, get, post, type Page } from "@/lib/api";
import { dateTime, humanizeTimestamps } from "@/lib/format";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/cn";
import { useWorkspaceZone } from "@/lib/session";
import { RichEditor, type RichEditorHandle } from "@/components/RichEditor";
import { SaveTemplateDialog, TemplatesPicker } from "@/components/sequence/tools";
import { Button, Callout, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, NativeSelect, NumberInput, Popover, Select, Switch, TagInput, Textarea, useConfirm } from "@/components/ui";
import {
  REMINDER_PRESETS,
  SEND_LATER_PRESETS,
  forwardSubject,
  isReceived,
  replySubject,
  sender,
  senderHint,
  splitAddresses,
  toLocalInput,
  type Email,
  type ThreadDetail,
} from "./shared";

export type ComposeMode = "reply" | "reply_all" | "forward";

interface Upload {
  id: string;
  filename: string;
  size: number;
}

type FollowUp =
  | { kind: "none" }
  | { kind: "reminder"; preset: string; custom: string }
  | { kind: "continue"; subsequence_id: string; step: number; wait: number; wait_unit: "minutes" | "hours" | "days" };

interface Draft {
  /** The email it answers or forwards, and the recipients and subject it started with there (see Composer). */
  targetId: string;
  base: { to: string[]; cc: string[]; subject: string };
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  showCc: boolean;
  subject: string;
  body: string;
  uploads: Upload[];
  includeQuote: boolean;
  followUp: FollowUp;
}

// Unsent drafts survive switching threads for the rest of the session: a reply per conversation (the lead writing
// again doesn't lose it), a forward per email.
const drafts = new Map<string, Draft>();
const draftKey = (threadId: string, mode: ComposeMode, targetId: string) => (mode === "forward" ? `${threadId}:forward:${targetId}` : `${threadId}:${mode}`);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const AI_QUICK = ["Answer their question", "Suggest a short call", "Ask a qualifying question", "Politely close the conversation"];

function defaultRecipients(mode: ComposeMode, target: Email, own: Set<string>): { to: string[]; cc: string[] } {
  if (mode === "forward") return { to: [], cc: [] };
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const to = isReceived(target) ? lower(splitAddresses(target.reply_to || sender(target).address)) : lower(splitAddresses(target.to_address_email_list));
  if (mode === "reply") return { to, cc: [] };
  const others = lower([...splitAddresses(target.to_address_email_list), ...splitAddresses(target.cc_address_email_list)]).filter((a) => !own.has(a) && !to.includes(a));
  return { to, cc: [...new Set(others)] };
}

export function Composer({
  thread,
  target,
  mode,
  inboxes,
  onClose,
  onSent,
}: {
  thread: ThreadDetail;
  target: Email;
  mode: ComposeMode;
  inboxes: Array<{ email: string; status: number }>;
  onClose: () => void;
  onSent: () => void;
}) {
  const key = draftKey(thread.thread_id, mode, target.id);
  const accounts = useQuery({
    queryKey: ["accounts", "picker"],
    queryFn: () => get<Page<Account>>("/api/v2/accounts", { limit: 1000, include_tags: true }),
    select: (d) => d.items,
  });
  const own = useMemo(() => new Set(inboxes.map((i) => i.email.toLowerCase())), [inboxes]);
  const [draft, setDraft] = useState<Draft>(() => {
    const firstActive = inboxes.find((i) => i.status === AccountStatus.ACTIVE)?.email ?? inboxes[0]?.email ?? "";
    const { to, cc } = defaultRecipients(mode, target, own);
    const subject = mode === "forward" ? forwardSubject(target.subject) : replySubject(target.subject);
    const saved = drafts.get(key);
    if (saved?.targetId === target.id) return saved;
    if (saved) {
      // Started on another email of this conversation (the lead wrote again since, or it was a follow-up): what was
      // written stays, and the recipients and subject that weren't changed follow this email.
      const keepCc = !sameList(saved.cc, saved.base.cc);
      return {
        ...saved,
        targetId: target.id,
        base: { to, cc, subject },
        to: sameList(saved.to, saved.base.to) ? to : saved.to,
        cc: keepCc ? saved.cc : cc,
        showCc: saved.showCc || (!keepCc && cc.length > 0),
        subject: saved.subject === saved.base.subject ? subject : saved.subject,
      };
    }
    return {
      targetId: target.id,
      base: { to, cc, subject },
      from: thread.suggested_account ?? firstActive,
      to,
      cc,
      bcc: [],
      showCc: cc.length > 0,
      subject,
      body: "",
      uploads: [],
      includeQuote: true,
      followUp: { kind: "none" },
    };
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const editor = useRef<RichEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<{ tone: "warn" | "info" | "bad"; text: string } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [laterOpen, setLaterOpen] = useState(false);
  const [laterAt, setLaterAt] = useState(() => toLocalInput(SEND_LATER_PRESETS[1]!.at()));
  const [saveOpen, setSaveOpen] = useState(false);

  // Keep the latest draft for when this composer unmounts (switching threads, closing the panel).
  const latest = useRef(draft);
  latest.current = draft;
  const sent = useRef(false);
  useEffect(
    () => () => {
      if (sent.current) return;
      const d = latest.current;
      if (htmlToText(d.body).trim() || d.uploads.length) drafts.set(key, d);
      else drafts.delete(key);
    },
    [key],
  );

  const account = accounts.data?.find((a) => a.email.toLowerCase() === draft.from.toLowerCase());
  const zone = useWorkspaceZone();
  const lead = thread.lead;
  const forward = mode === "forward";
  const switchedAccount = !forward && !!thread.suggested_account && !!draft.from && thread.suggested_account.toLowerCase() !== draft.from.toLowerCase();
  const fromOptions = (accounts.data?.length ? accounts.data.map((a) => ({ email: a.email, status: a.status, name: `${a.first_name} ${a.last_name}`.trim() })) : inboxes.map((i) => ({ ...i, name: "" }))).map((a) => ({
    value: a.email,
    label: a.name ? `${a.name} <${a.email}>` : a.email,
    hint: senderHint(a.status),
    disabled: a.status === AccountStatus.PAUSED,
  }));

  const discard = () => {
    drafts.delete(key);
    sent.current = true;
    onClose();
  };

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
      setDraft((d) => ({ ...d, uploads: [...d.uploads, ...r.files] }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const applyTemplate = (body: string) => {
    const vars = writtenEmailVariables(lead ?? { email: target.lead }, { email: draft.from, first_name: account?.first_name, last_name: account?.last_name, signature: account?.signature }, zone);
    const r = renderTemplate(body, vars, { escapeHtml: true, keepUnresolved: true });
    if (r.warnings.length) toast.warning("Template added. Some variables had no lead data, so check the text before sending.");
    if (htmlToText(draft.body).trim()) editor.current?.insertText(r.output);
    else set({ body: r.output });
  };

  const aiDraft = async (instruction: string) => {
    const written = () => htmlToText(latest.current.body).trim();
    const before = written();
    if (before && !(await confirm({ title: "Replace your reply?", description: "The AI's draft replaces what you've written.", confirmLabel: "Replace" }))) return;
    setAiBusy(true);
    setAiNote(null);
    try {
      const r = await post<{ decision: string; html: string; confidence: number; needs_human: boolean; human_reason: string | null; information_requested: string | null; guidance_from: { name: string } | null }>(
        `/api/app/unibox/threads/${thread.thread_id}/ai-reply`,
        { instruction: instruction.trim() || undefined, eaccount: draft.from || undefined },
      );
      // Writing on while the AI drafted isn't overwritten without asking.
      const now = written();
      if (r.html && now && now !== before) {
        const replace = await confirm({
          title: "Use the AI's draft?",
          description: "You kept writing while the AI drafted. Its draft would replace your reply.",
          confirmLabel: "Use the AI's draft",
          cancelLabel: "Keep mine",
        });
        if (!replace) {
          setAiOpen(false);
          return;
        }
      }
      if (r.html) set({ body: r.html });
      if (r.decision === "no_reply") setAiNote({ tone: "info", text: "The AI suggests not replying: the prospect asked to stop or there is nothing to answer." });
      else if (r.decision === "request_info") setAiNote({ tone: "warn", text: `The AI needs information it doesn't have${r.information_requested ? `: ${r.information_requested}` : "."}` });
      else if (r.needs_human) setAiNote({ tone: "warn", text: `Review carefully before sending${r.human_reason ? ` (${r.human_reason.toLowerCase()})` : ""}. Confidence ${r.confidence}%.` });
      else setAiNote({ tone: "info", text: `Drafted${r.guidance_from ? ` with the guidance of “${r.guidance_from.name}”` : ""}. Confidence ${r.confidence}%. Edit freely before sending.` });
      setAiOpen(false);
      setAiInstruction("");
    } catch (e) {
      setAiNote({ tone: "bad", text: errorMessage(e) });
    } finally {
      setAiBusy(false);
    }
  };

  const send = async (scheduledAt?: Date) => {
    if (uploading) return toast.error("Wait for the attachment to finish uploading.");
    if (!draft.from) return toast.error("Choose an account to send from.");
    if (!draft.to.length) return toast.error("Add at least one recipient.");
    if (!htmlToText(draft.body).trim() && !draft.uploads.length && !forward) return toast.error("Write a message first.");
    if (forward && !draft.subject.trim()) return toast.error("Add a subject.");
    const f = draft.followUp;
    if (f.kind === "continue" && scheduledAt) return toast.error("Continuing a subsequence works with immediate replies only. Turn it off to send later.");
    let reminder: string | undefined;
    if (f.kind === "reminder") {
      const at = f.preset === "custom" ? new Date(f.custom) : REMINDER_PRESETS.find((p) => p.key === f.preset)?.at();
      if (!at || Number.isNaN(at.getTime()) || at.getTime() < Date.now()) return toast.error("Choose a future date for the reminder.");
      reminder = at.toISOString();
    }
    setSending(true);
    try {
      const common = {
        eaccount: draft.from,
        reply_to_uuid: target.id,
        subject: draft.subject,
        body: { html: draft.body },
        cc_address_email_list: draft.cc.join(",") || undefined,
        bcc_address_email_list: draft.bcc.join(",") || undefined,
        attachment_ids: draft.uploads.map((u) => u.id),
        scheduled_at: scheduledAt?.toISOString(),
      };
      type Sent = Email & { continuation?: { name: string; step: number; scheduled_for: string; running?: boolean }; continuation_error?: string };
      const res = forward
        ? await post<Sent>("/api/v2/emails/forward", { ...common, to_address_email_list: draft.to.join(","), include_original_body: true })
        : await post<Sent>("/api/v2/emails/reply", {
            ...common,
            to: draft.to,
            include_quote: draft.includeQuote,
            reminder_ts: reminder,
            continuation: f.kind === "continue" ? { subsequence_id: f.subsequence_id, step: f.step - 1, wait: f.wait, wait_unit: f.wait_unit } : undefined,
          });
      sent.current = true;
      drafts.delete(key);
      const cont = res.continuation;
      if (scheduledAt) toast.success(`Scheduled for ${dateTime(scheduledAt)}`);
      // The reply went out either way; only what follows it didn't.
      else if (res.continuation_error) toast.warning(`Reply sent. ${res.continuation_error}`);
      else if (cont?.running === false) toast.success(`Sent. Step ${cont.step} of “${cont.name}” is due ${dateTime(cont.scheduled_for)} and goes out once “${cont.name}” and its campaign are running.`);
      else if (cont) toast.success(`Sent. Step ${cont.step} of “${cont.name}” goes out ${dateTime(cont.scheduled_for)} unless they reply.`);
      else toast.success(forward ? "Forwarded" : "Reply sent");
      onSent();
    } catch (e) {
      toast.error(humanizeTimestamps(errorMessage(e)));
    } finally {
      setSending(false);
    }
  };

  const f = draft.followUp;
  const activeSubs = thread.subsequences.filter((s) => s.steps > 0);
  // A subsequence that isn't running keeps the lead until it's started or resumed.
  const subLabel = (s: ThreadDetail["subsequences"][number]) =>
    s.status === CampaignStatus.ACTIVE ? s.name : `${s.name} (${s.status === CampaignStatus.PAUSED ? "paused" : s.status === CampaignStatus.DRAFT ? "not started" : "not running"})`;
  const chosenSub = f.kind === "continue" ? activeSubs.find((s) => s.id === f.subsequence_id) : undefined;
  const recipientsOk = (v: string) => isValidEmailSyntax(v);

  return (
    <div className="rounded-xl border border-line-strong bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <p className="text-[13px] font-semibold">{forward ? "Forward" : mode === "reply_all" ? "Reply all" : "Reply"}</p>
        <button type="button" aria-label="Close editor" onClick={onClose} className="rounded-md p-1 text-faint hover:bg-panel-2 hover:text-text">
          <X size={15} />
        </button>
      </div>

      <div className="space-y-2 px-4 py-3 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-muted">From</span>
          <Select size="sm" value={draft.from} onChange={(v) => set({ from: v })} options={fromOptions} placeholder="Choose an account" aria-label="Send from" />
        </div>
        {switchedAccount && (
          <p className="ml-14 flex items-start gap-1.5 text-xs text-warn">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            This conversation used {thread.suggested_account}. Replying from another account may split the thread for the lead.
          </p>
        )}
        {account?.status === AccountStatus.PAUSED && (
          <p className="ml-14 flex items-start gap-1.5 text-xs text-warn">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            {account.email} is paused, so it can't send. Resume it in Email accounts, or pick another mailbox.
          </p>
        )}
        <div className="flex items-start gap-2">
          <span className="mt-2 w-12 shrink-0 text-muted">To</span>
          <TagInput value={draft.to} onChange={(v) => set({ to: v.map((x) => x.toLowerCase()) })} validate={recipientsOk} placeholder="Add an email address" className="min-h-8 py-1" />
          {!draft.showCc && (
            <button type="button" className="mt-2 shrink-0 text-xs text-muted hover:text-text" onClick={() => set({ showCc: true })}>
              Cc / Bcc
            </button>
          )}
        </div>
        {draft.showCc && (
          <>
            <div className="flex items-start gap-2">
              <span className="mt-2 w-12 shrink-0 text-muted">Cc</span>
              <TagInput value={draft.cc} onChange={(v) => set({ cc: v.map((x) => x.toLowerCase()) })} validate={recipientsOk} className="min-h-8 py-1" />
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-2 w-12 shrink-0 text-muted">Bcc</span>
              <TagInput value={draft.bcc} onChange={(v) => set({ bcc: v.map((x) => x.toLowerCase()) })} validate={recipientsOk} className="min-h-8 py-1" />
            </div>
          </>
        )}
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-muted">Subject</span>
          <Input inputSize="sm" value={draft.subject} onChange={(e) => set({ subject: e.target.value })} aria-label="Subject" />
        </div>
      </div>

      <RichEditor
        ref={editor}
        value={draft.body}
        onChange={(html) => set({ body: html })}
        placeholder={forward ? "Add a note (optional)" : "Write your reply…"}
        minHeight={140}
        autoFocus
        className="border-y border-line"
        bare
        toolbarExtra={
          <>
            <TemplatesPicker reply onPick={(t) => applyTemplate(t.body)} onSaveCurrent={() => setSaveOpen(true)} />
            {!forward && (
              <Popover
                open={aiOpen}
                onOpenChange={setAiOpen}
                align="end"
                className="w-80"
                trigger={
                  <Button size="xs" variant="ghost" icon={<Sparkles size={13} />} loading={aiBusy}>
                    AI reply
                  </Button>
                }
              >
                <p className="mb-2 text-[13px] font-medium">Draft a reply with AI</p>
                <div className="space-y-1">
                  <button type="button" className="block w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-panel-2" onClick={() => aiDraft("")}>
                    Reply to their latest message
                  </button>
                  {AI_QUICK.map((q) => (
                    <button key={q} type="button" className="block w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-panel-2" onClick={() => aiDraft(q)}>
                      {q}
                    </button>
                  ))}
                </div>
                <Textarea className="mt-2" rows={2} value={aiInstruction} onChange={(e) => setAiInstruction(e.target.value)} placeholder="Or describe what to say…" />
                <div className="mt-2 flex justify-end">
                  <Button size="sm" variant="primary" disabled={!aiInstruction.trim()} loading={aiBusy} onClick={() => aiDraft(aiInstruction)}>
                    Draft
                  </Button>
                </div>
              </Popover>
            )}
          </>
        }
      />

      {aiNote && (
        <div className="px-4 pt-3">
          <Callout tone={aiNote.tone} action={<button type="button" aria-label="Dismiss" onClick={() => setAiNote(null)} className="text-faint hover:text-text"><X size={14} /></button>}>
            {aiNote.text}
          </Callout>
        </div>
      )}

      {!!draft.uploads.length && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {draft.uploads.map((u) => (
            <span key={u.id} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs">
              <Paperclip size={12} className="text-faint" />
              <span className="max-w-[14rem] truncate">{u.filename}</span>
              <button type="button" aria-label={`Remove ${u.filename}`} className="hit-24 text-faint hover:text-bad" onClick={() => set({ uploads: draft.uploads.filter((x) => x.id !== u.id) })}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {!forward && (
        <div className="space-y-2 px-4 pt-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">If no reply</span>
            <NativeSelect
              size="sm"
              className="w-auto"
              value={f.kind}
              onChange={(v) => {
                const kind = v as FollowUp["kind"];
                if (kind === "none") set({ followUp: { kind } });
                else if (kind === "reminder") set({ followUp: { kind, preset: "1w", custom: toLocalInput(REMINDER_PRESETS[2]!.at()) } });
                else if (activeSubs[0]) set({ followUp: { kind, subsequence_id: activeSubs[0].id, step: 1, wait: 3, wait_unit: "days" } });
              }}
              options={[
                { value: "none", label: "do nothing" },
                { value: "reminder", label: "remind me to follow up" },
                ...(activeSubs.length ? [{ value: "continue", label: "continue a subsequence" }] : []),
              ]}
              aria-label="If there is no reply"
            />
            {f.kind === "reminder" && (
              <>
                <NativeSelect
                  size="sm"
                  className="w-auto"
                  value={f.preset}
                  onChange={(v) => set({ followUp: { ...f, preset: v } })}
                  options={[...REMINDER_PRESETS.map((p) => ({ value: p.key, label: p.label[0]!.toLowerCase() + p.label.slice(1) })), { value: "custom", label: "on a date…" }]}
                  aria-label="Reminder time"
                />
                {f.preset === "custom" && (
                  <Input inputSize="sm" type="datetime-local" className="w-52" value={f.custom} onChange={(e) => set({ followUp: { ...f, custom: e.target.value } })} aria-label="Reminder date" />
                )}
              </>
            )}
            {f.kind === "continue" && (
              <>
                <NativeSelect
                  size="sm"
                  className="w-auto max-w-[14rem]"
                  value={f.subsequence_id}
                  onChange={(v) => set({ followUp: { ...f, subsequence_id: v, step: 1 } })}
                  options={activeSubs.map((s) => ({ value: s.id, label: subLabel(s) }))}
                  aria-label="Subsequence"
                />
                <span className="text-muted">at step</span>
                <NativeSelect
                  size="sm"
                  className="w-auto"
                  value={String(f.step)}
                  onChange={(v) => set({ followUp: { ...f, step: Number(v) } })}
                  options={Array.from({ length: activeSubs.find((s) => s.id === f.subsequence_id)?.steps ?? 1 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                  aria-label="Step"
                />
                <span className="text-muted">after</span>
                <NumberInput value={f.wait} onChange={(v) => set({ followUp: { ...f, wait: v ?? 0 } })} min={0} max={1000} className="w-20" aria-label="Wait" />
                <NativeSelect
                  size="sm"
                  className="w-auto"
                  value={f.wait_unit}
                  onChange={(v) => set({ followUp: { ...f, wait_unit: v as "minutes" | "hours" | "days" } })}
                  options={[
                    { value: "minutes", label: "minutes" },
                    { value: "hours", label: "hours" },
                    { value: "days", label: "days" },
                  ]}
                  aria-label="Wait unit"
                />
              </>
            )}
          </div>
          {f.kind === "continue" && (
            <p className="text-xs text-muted">
              Steps already sent won't repeat. A new reply from the lead stops the remaining follow-ups.
              {chosenSub && chosenSub.status !== CampaignStatus.ACTIVE && ` “${chosenSub.name}” isn't running, so step ${f.step} waits until it's started.`}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <div className="inline-flex">
          {/* Nothing goes out while an attachment is still uploading: it would be left off. */}
          <Button variant="primary" size="sm" icon={<Send size={13} />} loading={sending} disabled={uploading} onClick={() => send()} className="rounded-r-none">
            {forward ? "Forward" : "Send"}
          </Button>
          <Popover
            open={laterOpen}
            onOpenChange={setLaterOpen}
            align="start"
            className="w-72"
            trigger={
              <Button variant="primary" size="sm" aria-label="Send later" disabled={sending || uploading} className="rounded-l-none border-l border-white/25 px-2">
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
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <Button size="sm" variant="ghost" icon={<Paperclip size={13} />} loading={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? "Uploading…" : "Attach"}
        </Button>
        {!forward && (
          <label className="ml-1 flex items-center gap-2 text-xs text-muted">
            <Switch checked={draft.includeQuote} onChange={(v) => set({ includeQuote: v })} size="sm" aria-label="Include the previous message" />
            Quote previous message
          </label>
        )}
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="More options" className={cn("ml-auto")}>
              <ChevronDown size={14} />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => setSaveOpen(true)}>Save as reply template</MenuItem>
            <MenuSeparator />
            {/* While it's sending, the draft stays: a send that fails leaves it to try again. */}
            <MenuItem danger icon={<Trash2 size={14} />} onSelect={discard} disabled={sending}>
              Discard draft
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <SaveTemplateDialog open={saveOpen} onOpenChange={setSaveOpen} subject="" body={draft.body} reply />
    </div>
  );
}
