// Copilot chat: the sidebar (new chat, memory, tasks, settings, recent chats), the new-chat page and a chat.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  ArrowUp,
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  Copy,
  Link2,
  Mic,
  MicOff,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Settings2,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button, ButtonLink, Callout, Dialog, EmptyState, Field, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, RowMenu, Sheet, Skeleton, Textarea, useConfirm } from "@/components/ui";
import { ApiError, del, errorMessage, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { num } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { useSession } from "@/lib/session";
import { ToolCard, Working } from "./cards";
import { Markdown, plainText } from "./Markdown";
import { EMAIL_FRAMEWORKS, fillVariables, PROMPT_LIBRARY, QUICK_ACTIONS, type LibraryPrompt } from "./prompts";
import {
  clearError,
  liveOf,
  startStream,
  stopStream,
  THREADS_KEY,
  threadKey,
  useCopilotSettings,
  useCopilotStats,
  useLive,
  useThread,
  useThreads,
  type ChatAction,
  type ChatMessage,
  type DraftBlock,
  type Thread,
  type ThreadData,
} from "./api";

// ---------- Chat actions (rename, pin, share, delete) ----------

function patchThreadCaches(next: Thread) {
  queryClient.setQueryData<{ items: Thread[] }>(THREADS_KEY, (d) => d && { items: d.items.map((x) => (x.id === next.id ? { ...x, ...next } : x)) });
  queryClient.setQueryData<ThreadData>(threadKey(next.id), (d) => d && { ...d, thread: { ...d.thread, ...next } });
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Couldn't copy. Your browser blocked the clipboard.");
  }
}

function ThreadMenu({ thread, trigger }: { thread: Thread; trigger?: ReactNode }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const me = useSession();
  const [renaming, setRenaming] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const update = async (change: Partial<Pick<Thread, "title" | "pinned" | "shared">>) => {
    const next = await patch<Thread>(`/api/app/copilot/threads/${thread.id}`, change);
    patchThreadCaches(next);
    void queryClient.invalidateQueries({ queryKey: THREADS_KEY });
    return next;
  };
  const shareLink = `${window.location.origin}/app/w/${me.workspace?.id ?? ""}?next=${encodeURIComponent(`/app/copilot/${thread.id}`)}`;
  const run = (f: () => Promise<unknown>) => () => void f().catch((e) => toast.error(errorMessage(e)));
  const items = (
    <>
      <MenuItem icon={thread.pinned ? <PinOff size={14} /> : <Pin size={14} />} onSelect={run(() => update({ pinned: !thread.pinned }))}>
        {thread.pinned ? "Unpin" : "Pin"}
      </MenuItem>
      <MenuItem
        icon={<Pencil size={14} />}
        onSelect={() => {
          setTitle(thread.title);
          setRenaming(true);
        }}
      >
        Rename
      </MenuItem>
      {thread.shared ? (
        <>
          <MenuItem icon={<Link2 size={14} />} onSelect={() => setLinkOpen(true)}>
            Share link
          </MenuItem>
          <MenuItem
            icon={<Users size={14} />}
            onSelect={run(async () => {
              await update({ shared: false });
              toast.success("Only you can see this chat now");
            })}
          >
            Stop sharing
          </MenuItem>
        </>
      ) : (
        <MenuItem
          icon={<Users size={14} />}
          onSelect={run(async () => {
            await update({ shared: true });
            setLinkOpen(true);
          })}
        >
          Share with workspace
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        danger
        icon={<Trash2 size={14} />}
        onSelect={run(async () => {
          if (!(await confirm({ title: "Delete this chat?", description: `“${thread.title}” and its cards will be deleted. Things Copilot created (campaigns, lists, agents) stay.`, confirmLabel: "Delete", danger: true }))) return;
          await del(`/api/app/copilot/threads/${thread.id}`);
          queryClient.setQueryData<{ items: Thread[] }>(THREADS_KEY, (d) => d && { items: d.items.filter((x) => x.id !== thread.id) });
          queryClient.removeQueries({ queryKey: threadKey(thread.id) });
          if (pathname.startsWith(`/app/copilot/${thread.id}`)) navigate("/app/copilot");
          toast.success("Chat deleted");
        })}
      >
        Delete
      </MenuItem>
    </>
  );
  const save = async () => {
    setBusy(true);
    try {
      await update({ title: title.trim() });
      setRenaming(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {trigger ? (
        <Menu>
          <MenuTrigger asChild>{trigger}</MenuTrigger>
          <MenuContent>{items}</MenuContent>
        </Menu>
      ) : (
        <RowMenu label={`Actions for ${thread.title}`}>{items}</RowMenu>
      )}
      <Dialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        title="Share chat"
        description="Teammates in this workspace can read this chat with the link. Only you can reply."
        footer={
          <>
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={run(async () => {
                await update({ shared: false });
                setLinkOpen(false);
                toast.success("Only you can see this chat now");
              })}
            >
              Stop sharing
            </Button>
            <Button variant="primary" icon={<Copy size={14} />} onClick={() => void copyText(shareLink, "Link copied")}>
              Copy link
            </Button>
          </>
        }
      >
        <Input readOnly value={shareLink} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} autoFocus />
      </Dialog>
      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        size="sm"
        title="Rename chat"
        footer={
          <>
            <Button onClick={() => setRenaming(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Name">
          {(id) => <Input id={id} value={title} maxLength={120} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && void save()} />}
        </Field>
      </Dialog>
    </>
  );
}

// ---------- Sidebar ----------

function dayBucket(iso: string) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso).getTime();
  if (t >= today) return "Today";
  if (t >= today - 6 * 86_400_000) return "Previous 7 days";
  if (t >= today - 29 * 86_400_000) return "Previous 30 days";
  return "Older";
}

function ThreadRow({ t, onNavigate }: { t: Thread; onNavigate?: () => void }) {
  const live = useLive(t.id);
  const running = live.busy || t.status === "running";
  return (
    <li className="group relative">
      <NavLink
        to={`/app/copilot/${t.id}`}
        onClick={onNavigate}
        className={({ isActive }) => cn("flex items-center gap-2 rounded-md py-1.5 pl-2.5 pr-8 text-[13px]", isActive ? "bg-panel-2 font-medium text-text" : "text-muted hover:bg-panel-2 hover:text-text")}
      >
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
        {running ? (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Answering" />
        ) : t.status === "waiting" ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-warn" aria-label="Needs your input" title="Needs your input" />
        ) : t.task_id ? (
          <CalendarClock size={13} className="shrink-0 text-faint" aria-label="From a recurring task" />
        ) : t.shared ? (
          <Users size={13} className="shrink-0 text-faint" aria-label="Shared" />
        ) : null}
      </NavLink>
      <div className="absolute right-0.5 top-1/2 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
        <ThreadMenu thread={t} />
      </div>
    </li>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const threads = useThreads();
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const items = (threads.data?.items ?? []).filter((t) => !search.trim() || t.title.toLowerCase().includes(search.trim().toLowerCase()));
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: Thread[] }> = [];
    for (const t of items) {
      const label = t.pinned ? "Pinned" : dayBucket(t.updated_at);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(t);
      else out.push({ label, items: [t] });
    }
    return out;
  }, [items]);
  const link = ({ isActive }: { isActive: boolean }) => cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium", isActive ? "bg-panel-2 text-text" : "text-muted hover:bg-panel-2 hover:text-text");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-0.5 p-2.5">
        <ButtonLink to="/app/copilot" onClick={onNavigate} variant="soft" size="sm" className="mb-2 w-full justify-start" icon={<Plus size={14} />}>
          New chat
        </ButtonLink>
        <NavLink to="/app/copilot/memory" onClick={onNavigate} className={link}>
          <Brain size={15} /> Memory
        </NavLink>
        <NavLink to="/app/copilot/tasks" onClick={onNavigate} className={link}>
          <CalendarClock size={15} /> Tasks
        </NavLink>
        <NavLink to="/app/copilot/settings" onClick={onNavigate} className={link}>
          <Settings2 size={15} /> Settings
        </NavLink>
      </div>
      <div className="flex items-center justify-between px-5 pb-1 pt-2">
        <span className="text-xs font-medium text-faint">Recents</span>
        <button
          type="button"
          onClick={() => {
            setSearching(!searching);
            setSearch("");
          }}
          className="rounded p-1 text-faint hover:bg-panel-2 hover:text-text"
          aria-label={searching ? "Close search" : "Search chats"}
        >
          {searching ? <X size={13} /> : <Search size={13} />}
        </button>
      </div>
      {searching && (
        <div className="px-2.5 pb-1">
          <Input inputSize="sm" autoFocus placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search chats" />
        </div>
      )}
      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2.5 pb-3" aria-label="Recent chats">
        {threads.isLoading && (
          <div className="space-y-2 px-2.5 pt-1">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}
        {!threads.isLoading && !items.length && <p className="px-2.5 py-2 text-xs text-faint">{search ? "No chats match." : "Your chats show up here."}</p>}
        {groups.map((g) => (
          <div key={g.label} className="mt-2 first:mt-0">
            {(groups.length > 1 || g.label === "Pinned") && <p className="px-2.5 pb-0.5 pt-1 text-[11px] text-faint">{g.label}</p>}
            <ul>
              {g.items.map((t) => (
                <ThreadRow key={t.id} t={t} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

export function CopilotLayout() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-panel lg:block" aria-label="Copilot">
        <Sidebar />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 lg:hidden">
          <Button size="sm" variant="ghost" icon={<PanelLeft size={15} />} onClick={() => setOpen(true)}>
            Chats
          </Button>
          <ButtonLink to="/app/copilot" size="sm" variant="ghost" icon={<Plus size={15} />} className="ml-auto">
            New chat
          </ButtonLink>
        </div>
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <Sheet open={open} onOpenChange={setOpen} title="Copilot" width="max-w-xs">
        <Sidebar onNavigate={() => setOpen(false)} />
      </Sheet>
    </div>
  );
}

// ---------- Composer ----------

interface SpeechResultList {
  length: number;
  [i: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
type RecognitionCtor = new () => Recognition;

const speechCtor = (): RecognitionCtor | null => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** Voice input through the browser's own speech recognition, when it has one. */
function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  cb.current = onText;
  const Ctor = useMemo(() => speechCtor(), []);
  useEffect(() => () => rec.current?.stop(), []);
  const toggle = () => {
    if (!Ctor) return;
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      let said = "";
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i]!.isFinal) said += e.results[i]![0].transcript;
      if (said.trim()) cb.current(said.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed") toast.error("Allow microphone access to dictate.");
      else if (e.error !== "no-speech" && e.error !== "aborted") toast.error("Dictation stopped.");
    };
    rec.current = r;
    r.start();
    setListening(true);
  };
  return { supported: !!Ctor, listening, toggle };
}

function frameworkPrompt(f: (typeof EMAIL_FRAMEWORKS)[number]) {
  return `Help me write an email sequence using the "${f.name}" template: ${f.outline}`;
}

type SlashItem = { kind: "prompt"; prompt: LibraryPrompt } | { kind: "framework"; framework: (typeof EMAIL_FRAMEWORKS)[number] };

function PromptLibrary({ open, onOpenChange, onPick, initial }: { open: boolean; onOpenChange: (v: boolean) => void; onPick: (text: string) => void; initial?: LibraryPrompt | null }) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<LibraryPrompt | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setChosen(initial ?? null);
      setValues({});
    } else {
      setChosen(null);
      setSearch("");
    }
  }, [open, initial]);
  const pick = (p: LibraryPrompt) => {
    if (p.variables?.length) {
      setValues({});
      setChosen(p);
    } else {
      onPick(p.text);
      onOpenChange(false);
    }
  };
  const list = PROMPT_LIBRARY.filter((p) => !search.trim() || `${p.title} ${p.text}`.toLowerCase().includes(search.trim().toLowerCase()));
  const frameworks = EMAIL_FRAMEWORKS.filter((f) => !search.trim() || `${f.name} ${f.outline}`.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={chosen ? chosen.title : "Prompt library"} description={chosen ? "Fill in the blanks, then edit the prompt as you like." : "Starting points you can edit before sending."} width="max-w-md">
      {chosen ? (
        <div className="space-y-4 p-5">
          {chosen.variables!.map((v) => (
            <Field key={v.name} label={v.label}>
              {(id) => <Input id={id} value={values[v.name] ?? ""} placeholder={v.placeholder} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />}
            </Field>
          ))}
          <div className="rounded-lg bg-panel-2 p-3 text-[13px] text-muted">{fillVariables(chosen.text, values)}</div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setChosen(null)}>Back</Button>
            <Button
              variant="primary"
              onClick={() => {
                onPick(fillVariables(chosen.text, values));
                onOpenChange(false);
              }}
            >
              Use prompt
            </Button>
          </div>
        </div>
      ) : (
        <div className="p-5">
          <Input inputSize="sm" leading={<Search size={14} />} placeholder="Search prompts…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search prompts" />
          <p className="mb-1.5 mt-4 text-xs font-medium text-faint">Prompts</p>
          <ul className="space-y-1">
            {list.map((p) => (
              <li key={p.title}>
                <button type="button" onClick={() => pick(p)} className="w-full rounded-lg px-3 py-2 text-left hover:bg-panel-2">
                  <span className="block text-[13px] font-medium">{p.title}</span>
                  <span className="line-clamp-2 block text-xs text-muted">{p.text.replace(/\{\{(\w+)\}\}/g, "…")}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mb-1.5 mt-4 text-xs font-medium text-faint">Email frameworks</p>
          <ul className="space-y-1">
            {frameworks.map((f) => (
              <li key={f.name}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(frameworkPrompt(f));
                    onOpenChange(false);
                  }}
                  className="w-full rounded-lg px-3 py-2 text-left hover:bg-panel-2"
                >
                  <span className="block text-[13px] font-medium">{f.name}</span>
                  <span className="line-clamp-2 block text-xs text-muted">{f.outline}</span>
                </button>
              </li>
            ))}
          </ul>
          {!list.length && !frameworks.length && <p className="mt-4 text-[13px] text-muted">Nothing matches “{search}”.</p>}
        </div>
      )}
    </Sheet>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  busy,
  onStop,
  disabled,
  placeholder = "Ask Copilot anything…",
  autoFocus,
  extra,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string) => void;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Extra controls on the left of the toolbar (the recurring switch on a new chat). */
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [library, setLibrary] = useState(false);
  const [libraryPrompt, setLibraryPrompt] = useState<LibraryPrompt | null>(null);
  const [hi, setHi] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const dictation = useDictation((said) => onChange(latest.current.trim() ? `${latest.current.trimEnd()} ${said}` : said));
  const slash = /^\/([^\n]{0,40})$/.exec(value);
  const needle = slash?.[1]?.trim().toLowerCase() ?? "";
  const matches: SlashItem[] =
    slash && dismissed !== value
      ? [
          ...PROMPT_LIBRARY.filter((p) => p.title.toLowerCase().includes(needle)).map((prompt) => ({ kind: "prompt" as const, prompt })),
          ...EMAIL_FRAMEWORKS.filter((f) => f.name.toLowerCase().includes(needle)).map((framework) => ({ kind: "framework" as const, framework })),
        ]
      : [];
  useEffect(() => setHi(0), [needle]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);
  const insert = (text: string) => {
    onChange(text);
    // After any drawer has closed and handed focus back.
    setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    }, 60);
  };
  const choose = (it: SlashItem) => {
    if (it.kind === "framework") insert(frameworkPrompt(it.framework));
    else if (it.prompt.variables?.length) {
      onChange("");
      setLibraryPrompt(it.prompt);
      setLibrary(true);
    } else insert(it.prompt.text);
  };
  const submit = () => {
    if (busy || disabled || !value.trim()) return;
    onSend(value.trim());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => (h + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(matches[hi] ?? matches[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(value);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="relative">
      {matches.length > 0 && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-line bg-panel shadow-lg">
          <ul id="copilot-commands" role="listbox" aria-label="Prompts and templates" className="scroll-thin max-h-72 overflow-y-auto p-1">
            {matches.map((it, i) => {
              const first = i === 0 || matches[i - 1]!.kind !== it.kind;
              return (
                <li key={it.kind === "prompt" ? `p-${it.prompt.title}` : `f-${it.framework.name}`} role="presentation">
                  {first && <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-faint">{it.kind === "prompt" ? "Prompts" : "Generate a sequence from a template"}</p>}
                  <div
                    id={`cmd-${i}`}
                    role="option"
                    aria-selected={i === hi}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(it);
                    }}
                    onMouseEnter={() => setHi(i)}
                    className={cn("cursor-pointer rounded-md px-2.5 py-1.5", i === hi && "bg-panel-2")}
                  >
                    <span className="block text-[13px] font-medium">{it.kind === "prompt" ? it.prompt.title : it.framework.name}</span>
                    <span className="block truncate text-xs text-muted">{it.kind === "prompt" ? it.prompt.text.replace(/\{\{(\w+)\}\}/g, "…") : it.framework.outline}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className={cn("rounded-2xl border bg-panel shadow-card transition-colors focus-within:border-brand", disabled ? "border-line opacity-70" : "border-line-strong")}>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={dictation.listening ? "Listening…" : placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message Copilot"
          aria-autocomplete="list"
          aria-controls={matches.length ? "copilot-commands" : undefined}
          aria-activedescendant={matches.length ? `cmd-${hi}` : undefined}
          maxLength={20_000}
          className="scroll-thin block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Prompt library"
            title="Prompt library"
            disabled={disabled}
            onClick={() => {
              setLibraryPrompt(null);
              setLibrary(true);
            }}
          >
            <BookOpen size={15} />
          </Button>
          {dictation.supported && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
              aria-pressed={dictation.listening}
              title={dictation.listening ? "Stop dictation" : "Dictate"}
              disabled={disabled}
              onClick={dictation.toggle}
              className={cn(dictation.listening && "bg-bad-soft text-bad hover:bg-bad-soft hover:text-bad")}
            >
              {dictation.listening ? <MicOff size={15} /> : <Mic size={15} />}
            </Button>
          )}
          {extra}
          <div className="ml-auto flex items-center gap-1">
            <span className="hidden pr-1 text-[11px] text-faint sm:inline">{value ? "Shift + Enter for a new line" : "Type / for prompts and templates"}</span>
            {busy ? (
              <Button size="icon-sm" variant="primary" aria-label="Stop" title="Stop" onClick={onStop} className="rounded-full">
                <Square size={12} fill="currentColor" />
              </Button>
            ) : (
              <Button size="icon-sm" variant="primary" aria-label="Send" title="Send" disabled={disabled || !value.trim()} onClick={submit} className="rounded-full">
                <ArrowUp size={15} />
              </Button>
            )}
          </div>
        </div>
      </div>
      <PromptLibrary open={library} onOpenChange={setLibrary} onPick={insert} initial={libraryPrompt} />
    </div>
  );
}

function AiMissing() {
  const settings = useCopilotSettings();
  if (!settings.data || settings.data.ai_available) return null;
  return (
    <Callout tone="warn" title="Copilot needs AI" action={<ButtonLink to="/app/settings/integrations#ai" size="sm">Add a key</ButtonLink>}>
      Add an Anthropic API key in Settings → Integrations & API → AI, or ask the person who runs this installation to set up an AI (Claude, or a free one on
      their own computer) in Settings → Installation → Services.
    </Callout>
  );
}

// ---------- New chat ----------

const FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
] as const;
type Frequency = (typeof FREQUENCIES)[number]["value"];

export function NewChat() {
  usePageTitle("Copilot");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const live = useLive("new");
  const stats = useCopilotStats();
  const me = useSession();
  const [text, setText] = useState(() => params.get("prompt") ?? "");
  const [recurring, setRecurring] = useState<Frequency | null>(null);
  useEffect(() => () => clearError("new"), []);
  const send = (value: string) => {
    if (live.busy) return;
    clearError("new");
    void startStream({
      key: "new",
      url: "/api/app/copilot/chat",
      body: { text: value, ...(recurring ? { recurring: { frequency: recurring } } : {}) },
      onThread: (t) => navigate(`/app/copilot/${t.id}`),
    });
  };
  const first = me.user.first_name?.trim();
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center px-4 py-10 sm:px-6">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand-text">
            <Sparkles size={20} />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">{first ? `What can I help with, ${first}?` : "What can I help with?"}</h1>
          <p className="mt-1.5 text-[14px] text-muted">Find leads, write sequences, build campaigns and read your results.</p>
        </div>
        <div className="space-y-3">
          <AiMissing />
          {live.error && (
            <Callout tone="bad" title="Couldn't start the chat" action={<Button size="sm" variant="ghost" onClick={() => clearError("new")}>Dismiss</Button>}>
              {live.error}
            </Callout>
          )}
          <Composer
            value={text}
            onChange={setText}
            onSend={send}
            busy={live.busy}
            autoFocus
            placeholder="Ask Copilot to find leads, write a sequence or check your results…"
            extra={
              <Menu>
                <MenuTrigger asChild>
                  <Button size="xs" variant={recurring ? "soft" : "ghost"} icon={<Repeat size={14} />} aria-label="Make this a recurring task">
                    {recurring ? FREQUENCIES.find((f) => f.value === recurring)!.label : <span className="hidden sm:inline">Recurring</span>}
                  </Button>
                </MenuTrigger>
                <MenuContent align="start">
                  <MenuLabel>Run this prompt again</MenuLabel>
                  {FREQUENCIES.map((f) => (
                    <MenuItem key={f.value} icon={recurring === f.value ? <Check size={14} /> : <span />} onSelect={() => setRecurring(f.value)}>
                      {f.label}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuItem icon={recurring === null ? <Check size={14} /> : <span />} onSelect={() => setRecurring(null)}>
                    Just once
                  </MenuItem>
                </MenuContent>
              </Menu>
            }
          />
          {recurring && (
            <p className="text-center text-xs text-muted">
              Copilot will run this prompt {recurring === "daily" ? "every day" : recurring === "weekly" ? "every week" : "every month"} at this time and notify you. Manage it under{" "}
              <Link to="/app/copilot/tasks" className="text-brand-text hover:underline">
                Tasks
              </Link>
              .
            </p>
          )}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={live.busy}
              onClick={() => send(a.prompt)}
              className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2.5 text-left text-[13px] font-medium text-text shadow-card transition-colors hover:border-line-strong hover:bg-panel-2 disabled:opacity-60"
            >
              <a.icon size={15} className="shrink-0 text-brand-text" />
              <span className="min-w-0">{a.label}</span>
            </button>
          ))}
        </div>
        {stats.data?.enabled && stats.data.actions > 0 && (
          <p className="mt-6 text-center text-xs text-muted">
            Copilot has taken {num(stats.data.actions)} {stats.data.actions === 1 ? "action" : "actions"} for you
            {stats.data.hours_saved >= 0.1 ? `, saving about ${stats.data.hours_saved} ${stats.data.hours_saved === 1 ? "hour" : "hours"}` : ""}.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- A chat ----------

type Group = { role: "user"; message: ChatMessage } | { role: "assistant"; messages: ChatMessage[] };

function groupMessages(messages: ChatMessage[]): Group[] {
  const out: Group[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.role === "assistant" && last?.role === "assistant") last.messages.push(m);
    else out.push(m.role === "user" ? { role: "user", message: m } : { role: "assistant", messages: [m] });
  }
  return out;
}

function Avatar() {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-text">
      <Sparkles size={14} />
    </span>
  );
}

function Feedback({ message, threadId }: { message: ChatMessage; threadId: string }) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (helpful: boolean, note?: string) => {
    setBusy(true);
    try {
      const r = await post<{ feedback: ChatMessage["feedback"] }>(`/api/app/copilot/messages/${message.id}/feedback`, { helpful, text: note?.trim() || null });
      queryClient.setQueryData<ThreadData>(threadKey(threadId), (d) => d && { ...d, messages: d.messages.map((m) => (m.id === message.id ? { ...m, feedback: r.feedback } : m)) });
      setAsking(false);
      if (!helpful) toast.success("Thanks for the feedback");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const f = message.feedback;
  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label="Good answer" aria-pressed={f?.helpful === true} title="Good answer" disabled={busy} onClick={() => void send(true)} className={cn(f?.helpful === true && "text-ok")}>
        <ThumbsUp size={14} />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Bad answer"
        aria-pressed={f?.helpful === false}
        title="Bad answer"
        disabled={busy}
        onClick={() => {
          setText(f?.text ?? "");
          setAsking(true);
        }}
        className={cn(f?.helpful === false && "text-bad")}
      >
        <ThumbsDown size={14} />
      </Button>
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        title="What went wrong?"
        description="Optional. It helps whoever runs this installation see where Copilot falls short."
        footer={
          <>
            <Button onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void send(false, text)}>
              Send feedback
            </Button>
          </>
        }
      >
        <Textarea rows={4} autoFocus value={text} maxLength={2_000} onChange={(e) => setText(e.target.value)} placeholder="It got the numbers wrong, it didn't do what I asked…" aria-label="Feedback" />
      </Dialog>
    </>
  );
}

function DraftView({ draft, actions }: { draft: DraftBlock[]; actions: ChatAction[] }) {
  const visible = draft.filter((b) => (b.type === "text" && b.text) || b.type === "tool_use");
  const runningAction = actions.some((a) => a.status === "running");
  if (!visible.length) return runningAction ? null : <Working label={draft.some((b) => b.type === "thinking") ? "Thinking" : "Working"} />;
  const lastText = [...visible].reverse().find((b) => b.type === "text");
  return (
    <>
      {visible.map((b) =>
        b.type === "text" ? <Markdown key={b.index} text={b.text} className={cn(b === lastText && "stream-caret")} /> : <Working key={b.index} label={b.working ?? "Working"} />,
      )}
    </>
  );
}

function AssistantGroup({
  messages,
  actions,
  threadId,
  readOnly,
  busy,
  last,
  draft,
  onRetry,
  onSuggestion,
  canSend,
}: {
  messages: ChatMessage[];
  actions: ChatAction[];
  threadId: string;
  readOnly: boolean;
  busy: boolean;
  last: boolean;
  draft: DraftBlock[] | null;
  onRetry: () => void;
  onSuggestion: (s: string) => void;
  canSend: boolean;
}) {
  const byToolUse = useMemo(() => new Map(actions.map((a) => [a.tool_use_id, a])), [actions]);
  const final = messages[messages.length - 1];
  const text = messages
    .flatMap((m) => m.blocks)
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n\n");
  const settled = !(last && busy) && !!final;
  const waiting = actions.some((a) => a.status === "awaiting_approval" || a.status === "awaiting_answer");
  // An answer that made changes isn't tried again: that could make them twice.
  const changed = actions.some((a) => a.kind === "write" && a.status === "done");
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
        {messages.map((m) =>
          m.blocks.map((b, i) =>
            b.type === "text" ? (
              <Markdown key={`${m.id}-${i}`} text={b.text} />
            ) : byToolUse.get(b.id) ? (
              <ToolCard key={`${m.id}-${i}`} action={byToolUse.get(b.id)!} threadId={threadId} readOnly={readOnly} busy={busy} />
            ) : (
              <Working key={`${m.id}-${i}`} label="Working" />
            ),
          ),
        )}
        {draft && <DraftView draft={draft} actions={actions} />}
        {settled && text.trim() && (
          <div className="-mt-1.5 flex items-center gap-0.5 text-faint">
            <Button size="icon-sm" variant="ghost" aria-label="Copy answer" title="Copy" onClick={() => void copyText(plainText(text), "Copied")}>
              <Copy size={14} />
            </Button>
            {!readOnly && <Feedback message={final!} threadId={threadId} />}
            {!readOnly && last && !waiting && !changed && (
              <Button size="icon-sm" variant="ghost" aria-label="Try again" title="Try again" onClick={onRetry}>
                <RefreshCw size={14} />
              </Button>
            )}
          </div>
        )}
        {settled && last && canSend && !waiting && final!.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {final!.suggestions.map((s) => (
              <button key={s} type="button" onClick={() => onSuggestion(s)} className="rounded-full border border-line bg-panel px-3 py-1.5 text-left text-[13px] text-text shadow-card hover:border-line-strong hover:bg-panel-2">
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadView({ id }: { id: string }) {
  const live = useLive(id);
  const q = useThread(id, !live.busy);
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const data = q.data;
  usePageTitle(data?.thread.title ?? "Copilot");

  const messages = data?.messages ?? [];
  const actions = data?.actions ?? [];
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const draftLen = live.draft.reduce((n, b) => n + b.text.length + 1, 0);
  const lastGroup = groups[groups.length - 1];

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, actions, draftLen, live.busy, live.error]);

  if (q.isLoading)
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-8">
        <Skeleton className="ml-auto h-10 w-2/5 rounded-2xl" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  if (!data)
    return (
      <EmptyState
        className="mt-16"
        icon={<Sparkles size={20} />}
        title={q.error instanceof ApiError && q.error.status === 404 ? "Chat not found" : "Couldn't load this chat"}
        description={q.error instanceof ApiError && q.error.status === 404 ? "It may have been deleted, or it isn't shared with you." : errorMessage(q.error)}
        action={<ButtonLink to="/app/copilot">New chat</ButtonLink>}
      />
    );

  const { thread, limit } = data;
  const readOnly = !thread.mine;
  const busy = live.busy || thread.status === "running";
  const canSend = !readOnly && !limit.reached;

  const send = async (value: string) => {
    if (busy) return;
    clearError(id);
    stick.current = true;
    setText("");
    await startStream({ key: id, url: "/api/app/copilot/chat", body: { thread_id: id, text: value } });
    const after = queryClient.getQueryData<ThreadData>(threadKey(id));
    const echoed = after?.messages.some((m) => m.role === "user" && m.blocks.some((b) => b.type === "text" && b.text === value));
    // The message never reached the chat (for example while another answer was running): give the text back.
    if (liveOf(id).error && !echoed) setText((cur) => cur || value);
  };
  const retry = () => {
    if (busy) return;
    clearError(id);
    stick.current = true;
    void startStream({ key: id, url: `/api/app/copilot/threads/${id}/regenerate`, body: {} });
  };
  const stop = () => void stopStream(id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5 sm:px-6">
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{thread.title}</h1>
        {thread.task_id && (
          <ButtonLink to="/app/copilot/tasks" size="xs" variant="ghost" icon={<CalendarClock size={13} />} aria-label="Recurring task">
            <span className="hidden sm:inline">Recurring task</span>
          </ButtonLink>
        )}
        {thread.shared && (
          <span className="inline-flex items-center gap-1 rounded-full bg-panel-2 px-2 py-0.5 text-xs text-muted">
            <Users size={12} /> Shared
          </span>
        )}
        {thread.mine && (
          <ThreadMenu
            thread={thread}
            trigger={
              <Button size="icon-sm" variant="ghost" aria-label="Chat actions">
                <MoreHorizontal size={16} />
              </Button>
            }
          />
        )}
      </header>
      <div
        ref={scroller}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
          {readOnly && <Callout tone="info">A teammate shared this chat with the workspace. You can read it, but only they can reply.</Callout>}
          {groups.map((g, i) =>
            g.role === "user" ? (
              <div key={g.message.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-soft px-4 py-2.5 text-[14px] leading-relaxed text-text">{g.message.blocks[0]?.type === "text" ? g.message.blocks[0].text : ""}</div>
              </div>
            ) : (
              <AssistantGroup
                key={g.messages[0]!.id}
                messages={g.messages}
                actions={actions.filter((a) => g.messages.some((m) => m.id === a.message_id))}
                threadId={id}
                readOnly={readOnly}
                busy={busy}
                last={i === groups.length - 1}
                draft={i === groups.length - 1 && live.busy ? live.draft : null}
                onRetry={retry}
                onSuggestion={(s) => void send(s)}
                canSend={canSend}
              />
            ),
          )}
          {busy && lastGroup?.role !== "assistant" && (
            <div className="flex gap-3">
              <Avatar />
              <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">{live.busy ? <DraftView draft={live.draft} actions={actions} /> : <Working label="Working" />}</div>
            </div>
          )}
          {live.error && (
            <Callout
              tone="bad"
              title="Something went wrong"
              action={
                <div className="flex gap-1.5">
                  {!readOnly && (
                    <Button size="sm" onClick={retry}>
                      Try again
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => clearError(id)}>
                    Dismiss
                  </Button>
                </div>
              }
            >
              {live.error}
            </Callout>
          )}
          {limit.reached && !readOnly && (
            <Callout tone="info" title="This chat is full" action={<ButtonLink to="/app/copilot" size="sm">New chat</ButtonLink>}>
              A chat holds up to {limit.max_messages} messages. Start a new chat to keep going; Copilot remembers your business details.
            </Callout>
          )}
        </div>
      </div>
      {!readOnly && (
        <div className="border-t border-line bg-bg px-4 pb-4 pt-3 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <AiMissing />
            <Composer value={text} onChange={setText} onSend={(v) => void send(v)} busy={busy} onStop={stop} disabled={!canSend} placeholder={limit.reached ? "This chat is full. Start a new chat." : "Reply to Copilot…"} autoFocus />
            {!limit.reached && limit.max_messages - limit.used <= 5 && (
              <p className="mt-1.5 text-center text-xs text-muted">
                {limit.max_messages - limit.used} {limit.max_messages - limit.used === 1 ? "message" : "messages"} left in this chat
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatThread() {
  const { id = "" } = useParams();
  return <ThreadView key={id} id={id} />;
}
