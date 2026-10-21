// Sequence editor helpers: variable picker, templates, AI writers, spam check, preview and test send.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Braces, FileText, Library, Save, Search, Send, ShieldAlert, Sparkles, Trash2, Wand2 } from "lucide-react";
import { LEAD_VARIABLES, SENDER_VARIABLES, SYSTEM_VARIABLES, type SequenceStep } from "@reachstack/shared";
import { del, errorMessage, get, post } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/cn";
import { EmailFrame } from "@/components/EmailFrame";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  NativeSelect,
  Popover,
  Segmented,
  Select,
  Skeleton,
  Textarea,
  useConfirm,
} from "@/components/ui";

// ---------- Variables ----------

const SPINTAX = "{{RANDOM | first option | second option}}";

export function VariablesMenu({ onInsert, customVariables = [], label = "Variables", size = "xs" }: { onInsert: (text: string) => void; customVariables?: string[]; label?: string; size?: "xs" | "sm" }) {
  const item = (key: string, text: string) => (
    <MenuItem key={key} onSelect={() => onInsert(`{{${key}}}`)}>
      <span className="flex w-full items-center justify-between gap-3">
        {text}
        <code className="text-[11px] text-faint">{`{{${key}}}`}</code>
      </span>
    </MenuItem>
  );
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size={size} variant="ghost" icon={<Braces size={13} />}>
          {label}
        </Button>
      </MenuTrigger>
      <MenuContent className="max-h-96 w-72 overflow-y-auto">
        <MenuLabel>Lead</MenuLabel>
        {LEAD_VARIABLES.map((v) => item(v.key, v.label))}
        {customVariables.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Custom (from your lead lists)</MenuLabel>
            {customVariables.map((k) => item(k, k))}
          </>
        )}
        <MenuSeparator />
        <MenuLabel>Sender</MenuLabel>
        {SENDER_VARIABLES.map((v) => item(v.key, v.label))}
        <MenuSeparator />
        <MenuLabel>Other</MenuLabel>
        {SYSTEM_VARIABLES.map((v) => item(v.key, v.label))}
        <MenuItem onSelect={() => onInsert(SPINTAX)}>
          <span className="flex w-full items-center justify-between gap-3">
            Random text (spintax)
            <code className="text-[11px] text-faint">{"{{RANDOM | a | b}}"}</code>
          </span>
        </MenuItem>
        <MenuSeparator />
        <p className="px-2.5 py-1.5 text-[11px] leading-snug text-faint">
          Add a fallback for empty values: <code>{"{{firstName | there}}"}</code>
        </p>
      </MenuContent>
    </Menu>
  );
}

// ---------- Templates ----------

export interface TemplateItem {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string | null;
  is_reply_template?: boolean;
  is_library?: boolean;
}

export function useTemplates(type: "email" | "reply" | "all" = "email") {
  return useQuery({ queryKey: ["templates", type], queryFn: () => get<{ items: TemplateItem[]; categories: string[] }>("/api/app/templates", { type }) });
}

export function useTemplateLibrary() {
  return useQuery({ queryKey: ["templates", "library"], queryFn: () => get<{ items: TemplateItem[]; categories: string[] }>("/api/app/templates/library"), staleTime: Infinity });
}

export function SaveTemplateDialog({
  open,
  onOpenChange,
  subject,
  body,
  reply = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  subject: string;
  body: string;
  reply?: boolean;
}) {
  const qc = useQueryClient();
  const mine = useTemplates(reply ? "reply" : "email");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setCategory("");
    }
  }, [open]);
  const save = async () => {
    setBusy(true);
    try {
      await post("/api/app/templates", { name: name.trim(), subject, body, category: category.trim() || null, is_reply_template: reply });
      await qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success("Template saved");
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
      size="sm"
      title="Save as a template"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !body.trim()} onClick={save}>
            Save template
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name of template">{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Category" optional>
          {(id) => (
            <>
              <Input id={id} list="template-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Follow-ups" />
              <datalist id="template-categories">
                {mine.data?.categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/** Popover listing saved and built-in templates; picking one hands it to `onPick`. */
export function TemplatesPicker({ onPick, onSaveCurrent, reply = false, trigger }: { onPick: (t: TemplateItem) => void; onSaveCurrent?: () => void; reply?: boolean; trigger?: ReactNode }) {
  const [tab, setTab] = useState<"mine" | "library">("mine");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const mine = useTemplates(reply ? "reply" : "email");
  const library = useTemplateLibrary();
  const items = (tab === "mine" ? mine.data?.items : library.data?.items) ?? [];
  const shown = items.filter((t) => `${t.name} ${t.subject} ${t.category ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-96 p-0"
      trigger={
        trigger ?? (
          <Button size="xs" variant="ghost" icon={<FileText size={13} />}>
            Templates
          </Button>
        )
      }
    >
      <div className="border-b border-line p-2">
        {!reply && (
          <Segmented
            size="sm"
            className="mb-2 w-full"
            value={tab}
            onChange={setTab}
            options={[
              { value: "mine", label: "My templates" },
              { value: "library", label: "Library" },
            ]}
          />
        )}
        <Input inputSize="sm" leading={<Search size={13} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" />
      </div>
      <div className="scroll-thin max-h-80 overflow-y-auto p-1">
        {(tab === "mine" ? mine.isLoading : library.isLoading) && <Skeleton className="m-2 h-10" />}
        {shown.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              onPick(t);
              setOpen(false);
            }}
            className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-panel-2"
          >
            <span className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium">{t.name}</span>
              {t.category && <Badge className="ml-auto shrink-0">{t.category}</Badge>}
            </span>
            {t.subject && <span className="block truncate text-xs text-muted">{t.subject}</span>}
          </button>
        ))}
        {!shown.length && !(tab === "mine" ? mine.isLoading : library.isLoading) && (
          <p className="px-3 py-6 text-center text-xs text-muted">{tab === "mine" ? "No saved templates yet." : "Nothing matches."}</p>
        )}
      </div>
      {onSaveCurrent && (
        <div className="border-t border-line p-1.5">
          <Button
            size="xs"
            variant="ghost"
            className="w-full justify-start"
            icon={<Save size={13} />}
            onClick={() => {
              setOpen(false);
              onSaveCurrent();
            }}
          >
            Save current email as a template
          </Button>
        </div>
      )}
    </Popover>
  );
}

// ---------- AI sequence writer ----------

interface AvatarData {
  company_name: string;
  offer: string;
  audience: string;
  case_studies: string;
  cta: string;
  tone: string;
  language: string;
}

const EMPTY_BRIEF: AvatarData = { company_name: "", offer: "", audience: "", case_studies: "", cta: "", tone: "", language: "" };

export function AiSequenceDialog({ open, onOpenChange, onApply }: { open: boolean; onOpenChange: (v: boolean) => void; onApply: (steps: SequenceStep[]) => void }) {
  const qc = useQueryClient();
  const [brief, setBrief] = useState<AvatarData>(EMPTY_BRIEF);
  const [length, setLength] = useState("3");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Array<{ subject: string; body: string; delay: number }> | null>(null);
  const [avatarName, setAvatarName] = useState("");
  const avatars = useQuery({
    queryKey: ["ai-avatars"],
    queryFn: () => get<{ items: Array<{ id: string; name: string; data: AvatarData }> }>("/api/app/ai/avatars"),
    enabled: open,
  });
  useEffect(() => {
    if (open) setResult(null);
  }, [open]);
  const set = (k: keyof AvatarData) => (e: { target: { value: string } }) => setBrief({ ...brief, [k]: e.target.value });

  const generate = async () => {
    setBusy(true);
    try {
      const r = await post<{ steps: Array<{ subject: string; body: string; delay: number }> }>("/api/app/ai/sequence", { ...brief, steps: Number(length) });
      setResult(r.steps);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAvatar = async () => {
    try {
      await post("/api/app/ai/avatars", { name: avatarName.trim(), data: brief });
      await qc.invalidateQueries({ queryKey: ["ai-avatars"] });
      setAvatarName("");
      toast.success("Saved for next time");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const apply = () => {
    if (!result) return;
    // The writer returns "wait before this email"; steps store "wait before the next email".
    onApply(
      result.map((s, i) => ({
        type: "email" as const,
        delay: result[i + 1]?.delay ?? 3,
        delay_unit: "days" as const,
        variants: [{ subject: s.subject, body: s.body }],
      })),
    );
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="AI sequence writer"
      description="Describe your offer and audience. The writer drafts a complete sequence you can edit."
      footer={
        result ? (
          <>
            <Button onClick={() => setResult(null)}>Back to the brief</Button>
            <Button onClick={generate} loading={busy}>
              Write again
            </Button>
            <Button variant="primary" onClick={apply}>
              Use this sequence
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" icon={<Sparkles size={14} />} loading={busy} disabled={!brief.offer.trim() || !brief.audience.trim()} onClick={generate}>
              Write sequence
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          {result.map((s, i) => (
            <div key={i} className="rounded-lg border border-line">
              <div className="flex items-center justify-between border-b border-line bg-panel-2/60 px-3 py-1.5 text-xs text-muted">
                <span className="font-medium text-text">Step {i + 1}</span>
                {i > 0 && <span>Sent {s.delay} day{s.delay === 1 ? "" : "s"} after the previous step</span>}
              </div>
              <div className="px-3 py-2">
                <p className="mb-1 text-[13px] font-medium">{s.subject || <span className="text-muted">Same thread as the previous email</span>}</p>
                <EmailFrame html={s.body} minHeight={60} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {!!avatars.data?.items.length && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-panel-2 p-2">
              <span className="text-xs text-muted">Saved briefs</span>
              {avatars.data.items.map((a) => (
                <span key={a.id} className="inline-flex items-center rounded-md border border-line bg-panel">
                  <button type="button" className="px-2 py-1 text-xs hover:text-brand-text" onClick={() => setBrief({ ...EMPTY_BRIEF, ...a.data })}>
                    {a.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${a.name}`}
                    className="border-l border-line px-1.5 py-1 text-faint hover:text-bad"
                    onClick={async () => {
                      await del(`/api/app/ai/avatars/${a.id}`).catch((e) => toast.error(errorMessage(e)));
                      qc.invalidateQueries({ queryKey: ["ai-avatars"] });
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Your company name">{(id) => <Input id={id} value={brief.company_name} onChange={set("company_name")} />}</Field>
            <Field label="How many emails?">
              {(id) => <Select id={id} value={length} onChange={setLength} options={["1", "2", "3", "4", "5", "6", "7"].map((n) => ({ value: n, label: `${n} step${n === "1" ? "" : "s"}` }))} />}
            </Field>
          </div>
          <Field label="What are you offering?" hint="Be specific: what it is, what it costs or takes, and the result people get. 3-4 sentences.">
            {(id) => <Textarea id={id} rows={3} value={brief.offer} onChange={set("offer")} />}
          </Field>
          <Field label="Who is it for?" hint="Roles, company types and the problem they have. 2-3 sentences.">
            {(id) => <Textarea id={id} rows={2} value={brief.audience} onChange={set("audience")} />}
          </Field>
          <Field label="Proof you can share" optional hint="A customer result or case study. The writer won't invent any.">
            {(id) => <Textarea id={id} rows={2} value={brief.case_studies} onChange={set("case_studies")} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Call to action" optional>
              {(id) => <Input id={id} value={brief.cta} onChange={set("cta")} placeholder="A 15-minute call" />}
            </Field>
            <Field label="Tone" optional>
              {(id) => <Input id={id} value={brief.tone} onChange={set("tone")} placeholder="Friendly, direct" />}
            </Field>
            <Field label="Language" optional>
              {(id) => <Input id={id} value={brief.language} onChange={set("language")} placeholder="English" />}
            </Field>
          </div>
          <div className="flex items-center gap-2 border-t border-line pt-3">
            <Input inputSize="sm" className="max-w-xs" value={avatarName} onChange={(e) => setAvatarName(e.target.value)} placeholder="Name this brief to reuse it" />
            <Button size="sm" disabled={!avatarName.trim() || !brief.offer.trim()} onClick={saveAvatar}>
              Save brief
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------- AI write / rewrite ----------

const QUICK = ["Make it shorter", "Make it friendlier", "Make it more formal", "Fix grammar and spelling", "End with one clear question", "Make the first line about them"];

export function AiWriteDialog({
  open,
  onOpenChange,
  subject,
  body,
  onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  subject: string;
  body: string;
  onApply: (r: { subject: string; body: string }) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ subject: string; body: string } | null>(null);
  const empty = !body.replace(/<[^>]+>/g, "").trim();
  useEffect(() => {
    if (open) {
      setResult(null);
      setInstruction("");
    }
  }, [open]);
  const run = async (text = instruction) => {
    if (!text.trim()) return;
    setInstruction(text);
    setBusy(true);
    try {
      setResult(await post<{ subject: string; body: string }>("/api/app/ai/write", { instruction: text, subject, body, with_subject: empty || !subject }));
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
      title={empty ? "Write with AI" : "Rewrite with AI"}
      footer={
        result ? (
          <>
            <Button onClick={() => setResult(null)}>Try another instruction</Button>
            <Button
              variant="primary"
              onClick={() => {
                onApply(result);
                onOpenChange(false);
              }}
            >
              Replace email
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" icon={<Wand2 size={14} />} loading={busy} disabled={!instruction.trim()} onClick={() => run()}>
              {empty ? "Write" : "Rewrite"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="rounded-lg border border-line p-3">
          {result.subject && <p className="mb-2 text-[13px] font-medium">{result.subject}</p>}
          <EmailFrame html={result.body} minHeight={80} />
        </div>
      ) : (
        <div className="space-y-3">
          <Textarea
            autoFocus
            rows={4}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={empty ? "Who are you writing to and what should the email ask for?" : "How should the email change?"}
          />
          {!empty && (
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((qk) => (
                <button key={qk} type="button" disabled={busy} onClick={() => run(qk)} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:border-brand hover:text-brand-text">
                  {qk}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---------- Spam words ----------

interface SpamFinding {
  phrase: string;
  where: "subject" | "body";
  reason: string;
  replacement: string;
}

interface SpamResult {
  method: "ai" | "rules";
  findings: SpamFinding[];
  score: { engine: string; is_spam: boolean; spam_score: number; threshold: number; report: Array<{ name: string; description: string; score: string }> };
  ai_error?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with each whole-word `phrase` (any case) replaced: "cheap" isn't found in "cheaper". {{variables}} stay as they
 * are, while spintax options change like any text. Removing a phrase takes the space before it too.
 */
function replacePhrase(text: string, phrase: string, replacement: string): string {
  if (!phrase.trim()) return text;
  const words = `(?<![\\p{L}\\p{N}_])${escapeRe(phrase.trim())}(?![\\p{L}\\p{N}_])`;
  const re = new RegExp(replacement ? words : `[ \\t\\u00a0]?${words}`, "giu");
  return text
    .split(/(\{\{[\s\S]*?\}\})/)
    .map((part, i) => (i % 2 && !/^\{\{\s*random\s*\|/i.test(part) ? part : part.replace(re, () => replacement)))
    .join("");
}

/** An email's HTML with the phrase replaced in what it says, never in its tags, link addresses or {{variable}} names. */
function replacePhraseInHtml(html: string, phrase: string, replacement: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let changed = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement?.closest("style, script")) continue;
    const next = replacePhrase(n.nodeValue ?? "", phrase, replacement);
    if (next === n.nodeValue) continue;
    n.nodeValue = next;
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

export function SpamCheckDialog({
  open,
  onOpenChange,
  subject,
  body,
  onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  subject: string;
  body: string;
  onApply: (r: { subject: string; body: string }) => void;
}) {
  const [checks, setChecks] = useState(0);
  const [editing, setEditing] = useState<SpamFinding | null>(null);
  const [replacement, setReplacement] = useState("");
  const q = useQuery({
    queryKey: ["spam-check", subject, body, checks],
    queryFn: () => post<SpamResult>("/api/app/ai/spam-words", { subject, body }),
    enabled: open && !!(subject || body),
    staleTime: Infinity,
  });
  const r = q.data;
  const replace = () => {
    if (!editing) return;
    const to = replacement.trim();
    const next = {
      subject: editing.where === "subject" ? replacePhrase(subject, editing.phrase, to) : subject,
      body: editing.where === "body" ? replacePhraseInHtml(body, editing.phrase, to) : body,
    };
    if (next.subject === subject && next.body === body) return void toast.error(`“${editing.phrase}” isn't in the ${editing.where} as written. Change it by hand.`);
    onApply(next);
    setEditing(null);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title="Spam words checker" description="Phrases that often push cold email into spam folders, with gentler alternatives.">
      {q.isLoading ? (
        <div className="space-y-2">
          <p className="text-[13px] text-muted">Checking spam words…</p>
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : r ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={r.score.is_spam ? "bad" : r.score.spam_score >= r.score.threshold / 2 ? "warn" : "ok"}>
              Content score {r.score.spam_score.toFixed(1)} / {r.score.threshold}
            </Badge>
            <span className="text-xs text-muted">{r.score.engine === "spamassassin" ? "Scored by SpamAssassin" : "Scored by built-in rules"}</span>
            <span className="text-xs text-muted">· {r.method === "ai" ? "Phrases reviewed by AI" : "Phrase list check"}</span>
            <Button size="xs" className="ml-auto" onClick={() => setChecks(checks + 1)}>
              Re-check
            </Button>
          </div>
          {r.ai_error && <Callout tone="warn">AI review unavailable ({r.ai_error}). Showing the built-in phrase list only.</Callout>}
          {r.findings.length ? (
            <>
              <p className="text-xs text-muted">Click a card to replace the phrase.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {r.findings.map((f) => (
                  <button
                    key={`${f.where}-${f.phrase}`}
                    type="button"
                    onClick={() => {
                      setEditing(f);
                      setReplacement(f.replacement);
                    }}
                    className="rounded-lg border border-line p-3 text-left hover:border-brand"
                  >
                    <span className="flex items-center gap-2">
                      <ShieldAlert size={14} className="text-warn" />
                      <span className="font-medium">“{f.phrase}”</span>
                      <Badge className="ml-auto">{f.where}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted">{f.reason}</span>
                    {f.replacement && <span className="mt-1 block text-xs">Try: {f.replacement}</span>}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <Callout tone="ok" title={checks ? "Looking good!" : "Looking good so far!"}>
              {checks ? "No spam triggers found in multiple checks." : "No spam triggers found. Run another check after you edit the email."}
            </Callout>
          )}
          {r.score.report.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Rule details</summary>
              <ul className="mt-2 space-y-1">
                {r.score.report.map((x) => (
                  <li key={x.name}>
                    <span className="font-mono">{x.score}</span> {x.description}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-muted">Write something first.</p>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        size="sm"
        title="Change spam word"
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={replace}>
              {replacement.trim() ? "Apply" : "Remove phrase"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px]">
          <p>
            Original: <span className="font-medium">“{editing?.phrase}”</span>
          </p>
          <Field label="Replacement">{(id) => <Input id={id} autoFocus value={replacement} onChange={(e) => setReplacement(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </Dialog>
  );
}

// ---------- Preview & test email ----------

interface PreviewResult {
  subject: string;
  body: string;
  /** The step goes out as plain text (the body is that text). */
  text_only: boolean;
  lead: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
  account_email: string | null;
  warnings: string[];
}

export function PreviewDialog({
  open,
  onOpenChange,
  campaignId,
  subject,
  body,
  step,
  subsequence,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId: string;
  subject: string;
  body: string;
  /** Which step this is, and whether it's a subsequence's: the first email can go out as plain text. */
  step: number;
  subsequence?: boolean;
}) {
  const me = useMe();
  const [leadId, setLeadId] = useState("");
  const [account, setAccount] = useState("");
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const leads = useQuery({
    queryKey: ["leads", "preview-picker", campaignId],
    queryFn: () => post<{ items: Array<{ id: string; email: string; first_name: string | null; last_name: string | null }> }>("/api/v2/leads/list", { campaign: campaignId, limit: 50 }),
    enabled: open,
  });
  const accounts = useQuery({
    queryKey: ["campaign", campaignId, "accounts"],
    queryFn: () => get<Array<{ email: string; status: number }>>(`/api/app/campaigns/${campaignId}/accounts`),
    enabled: open,
  });
  useEffect(() => {
    if (open && !to && me.data?.user.email) setTo(me.data.user.email);
  }, [open, to, me.data]);
  const target = { subject, body, step, subsequence: !!subsequence, lead_id: leadId || undefined, account_email: account || undefined };
  const preview = useQuery({
    queryKey: ["campaign", campaignId, "preview", target],
    queryFn: () => post<PreviewResult>(`/api/app/campaigns/${campaignId}/preview`, target),
    enabled: open,
  });
  const p = preview.data;
  const send = async () => {
    setSending(true);
    try {
      const r = await post<{ from: string }>(`/api/app/campaigns/${campaignId}/test-email`, { ...target, to });
      toast.success(`Test email sent from ${r.from} to ${to}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  const leadOptions = useMemo(
    () => [{ value: "", label: "First lead in the campaign (or sample data)" }, ...(leads.data?.items ?? []).map((l) => ({ value: l.id, label: [l.first_name, l.last_name].filter(Boolean).join(" ") ? `${[l.first_name, l.last_name].filter(Boolean).join(" ")} · ${l.email}` : l.email }))],
    [leads.data],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl" title="Preview email">
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div className="space-y-3">
          <Field label="Lead">{(id) => <NativeSelect id={id} size="sm" value={leadId} onChange={setLeadId} options={leadOptions} />}</Field>
          <Field label="Send from">
            {(id) => (
              <NativeSelect
                id={id}
                size="sm"
                value={account}
                onChange={setAccount}
                options={[{ value: "", label: "First sending account" }, ...(accounts.data ?? []).map((a) => ({ value: a.email, label: a.email }))]}
              />
            )}
          </Field>
          <div className="space-y-2 rounded-lg bg-panel-2 p-3">
            <Field label="Send a test to">{(id) => <Input id={id} inputSize="sm" type="email" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            <Button size="sm" className="w-full" icon={<Send size={13} />} loading={sending} disabled={!to.includes("@") || !accounts.data?.length} onClick={send}>
              Send test email
            </Button>
            {accounts.data && !accounts.data.length && <p className="text-xs text-muted">Select sending accounts in Options first.</p>}
          </div>
        </div>
        <div className="min-w-0 rounded-lg border border-line">
          {preview.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24" />
            </div>
          ) : preview.isError ? (
            <p className="p-4 text-[13px] text-bad">{errorMessage(preview.error)}</p>
          ) : p ? (
            <>
              <div className="space-y-1 border-b border-line px-4 py-3 text-[13px]">
                <p>
                  <span className="text-muted">From </span>
                  {p.account_email ?? "No sending account selected"}
                </p>
                <p>
                  <span className="text-muted">To </span>
                  {p.lead?.email ?? "alex@example.com (sample)"}
                </p>
                <p className="font-medium">{p.subject || <span className="text-muted">(subject of the previous email)</span>}</p>
              </div>
              <div className={cn("px-4 py-3", p.text_only && "font-mono text-[13px]")}>
                <EmailFrame html={p.body} />
              </div>
              {!!p.warnings.length && (
                <div className="border-t border-line px-4 py-2 text-xs text-warn">
                  {p.warnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** "AI tools" dropdown for the editor toolbar. */
export function AiToolsMenu({ onSequence, onSpintax, onSpam, onWrite, spinning }: { onSequence?: () => void; onSpintax: () => void; onSpam: () => void; onWrite: () => void; spinning?: boolean }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="xs" variant="ghost" icon={<Sparkles size={13} />} loading={spinning}>
          AI tools
        </Button>
      </MenuTrigger>
      <MenuContent>
        {onSequence && (
          <MenuItem icon={<Library size={14} />} onSelect={onSequence}>
            AI sequence writer
          </MenuItem>
        )}
        <MenuItem icon={<Wand2 size={14} />} onSelect={onWrite}>
          Write or rewrite this email
        </MenuItem>
        <MenuItem icon={<Sparkles size={14} />} onSelect={onSpintax}>
          AI spintax writer
        </MenuItem>
        <MenuItem icon={<ShieldAlert size={14} />} onSelect={onSpam}>
          Spam words checker
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Confirms before replacing content, used by the template and AI flows. */
export function useReplaceConfirm() {
  const confirm = useConfirm();
  return (hasContent: boolean, what = "this email") =>
    hasContent ? confirm({ title: `Replace ${what}?`, description: "What you've written so far will be replaced. Nothing is saved until you click Save.", confirmLabel: "Replace" }) : Promise.resolve(true);
}
