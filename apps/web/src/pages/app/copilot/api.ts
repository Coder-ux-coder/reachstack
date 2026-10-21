// Copilot data: chat types, the query hooks, and the streaming store. An answer streams into a module-level
// store (not component state), so it keeps going while the user moves between chats and pages.
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, get } from "@/lib/api";
import { queryClient } from "@/lib/query";

export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  stop_reason: string | null;
  feedback: { helpful: boolean; text?: string | null } | null;
  suggestions: string[];
  created_at: string;
}

export type ActionStatus = "running" | "done" | "error" | "awaiting_approval" | "denied" | "awaiting_answer" | "answered" | "skipped";

export interface ChatAction {
  id: string;
  tool_use_id: string;
  message_id: string;
  tool: string;
  kind: "read" | "display" | "write" | "question";
  status: ActionStatus;
  working: string;
  summary: string | null;
  input: Record<string, unknown>;
  card: (Record<string, unknown> & { type: string }) | null;
  answers: Array<{ question: string; answer: string[] }> | null;
  error: string | null;
  created_at: string;
}

export interface Thread {
  id: string;
  title: string;
  status: "idle" | "running" | "waiting";
  pinned: boolean;
  shared: boolean;
  task_id: string | null;
  mine: boolean;
  created_at: string;
  updated_at: string;
}

export interface ThreadData {
  thread: Thread;
  messages: ChatMessage[];
  actions: ChatAction[];
  limit: { max_messages: number; used: number; reached: boolean };
}

export interface CopilotTask {
  id: string;
  title: string;
  prompt: string;
  frequency: "daily" | "weekly" | "monthly";
  time_of_day: string | null;
  timezone: string | null;
  status: "active" | "paused";
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "success" | "failed" | "waiting" | null;
  last_error: string | null;
  last_thread_id: string | null;
  last_result: string | null;
  run_count: number;
  /** A run is in progress right now. */
  running: boolean;
  source_thread_id: string | null;
  created_at: string;
}

export const CHAT_MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
};

export interface CopilotSettings {
  warp_mode: boolean;
  follow_up_suggestions: boolean;
  analytics: boolean;
  execute_tools: boolean;
  enrich_leads_limit: number;
  slack_integration_id: string | null;
  chat_model: string | null;
}

export interface CopilotSettingsData {
  settings: CopilotSettings;
  models: string[];
  workspace_model: string | null;
  slack_connections: Array<{ id: string; name: string }>;
  ai_available: boolean;
}

export const THREADS_KEY = ["copilot-threads"] as const;
export const threadKey = (id: string) => ["copilot-thread", id] as const;
export const TASKS_KEY = ["copilot-tasks"] as const;
export const SETTINGS_KEY = ["copilot-settings"] as const;

export function useThreads() {
  return useQuery({ queryKey: THREADS_KEY, queryFn: () => get<{ items: Thread[] }>("/api/app/copilot/threads"), staleTime: 15_000 });
}

/** `poll`: refetch every 2 s while the server is answering without this tab streaming it (after a reload). */
export function useThread(id: string | undefined, poll = false) {
  return useQuery({
    queryKey: threadKey(id ?? ""),
    queryFn: () => get<ThreadData>(`/api/app/copilot/threads/${id}`),
    enabled: !!id,
    staleTime: 5_000,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
    refetchInterval: (q) => (poll && q.state.data?.thread.status === "running" ? 2_000 : false),
  });
}

export function useCopilotSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => get<CopilotSettingsData>("/api/app/copilot/settings"), staleTime: 30_000 });
}

export function useTasks(poll = false) {
  return useQuery({
    queryKey: TASKS_KEY,
    queryFn: () => get<{ items: CopilotTask[] }>("/api/app/copilot/tasks"),
    refetchInterval: (q) => (poll || q.state.data?.items.some((t) => t.running) ? 3_000 : false),
  });
}

export function useCopilotStats() {
  return useQuery({ queryKey: ["copilot-stats"], queryFn: () => get<{ enabled: boolean; actions: number; hours_saved: number }>("/api/app/copilot/stats"), staleTime: 30_000 });
}

// ---------- Live (streaming) state ----------

export interface DraftBlock {
  index: number;
  type: "text" | "thinking" | "tool_use";
  text: string;
  name?: string;
  working?: string;
}

export interface Live {
  busy: boolean;
  draft: DraftBlock[];
  error: string | null;
}

const EMPTY: Live = { busy: false, draft: [], error: null };
const lives = new Map<string, Live>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function setLive(key: string, patch: Partial<Live> | ((l: Live) => Partial<Live>)) {
  const cur = lives.get(key) ?? EMPTY;
  lives.set(key, { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) });
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Streaming state of a chat ("new" before the server has created it). */
export function useLive(key: string): Live {
  return useSyncExternalStore(
    subscribe,
    () => lives.get(key) ?? EMPTY,
    () => EMPTY,
  );
}

function patchThread(id: string, f: (d: ThreadData) => ThreadData) {
  queryClient.setQueryData<ThreadData>(threadKey(id), (d) => (d ? f(d) : d));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = [...list];
  next[i] = item;
  return next;
}

/** Reads a POST response as server-sent events. */
async function readEvents(url: string, body: unknown, signal: AbortSignal, onEvent: (event: string, data: unknown) => void) {
  const res = await fetch(url, { method: "POST", headers: { "x-rs-csrf": "1", "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", signal });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = res.statusText || "Request failed";
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

interface StartOptions {
  /** Store key: the thread id, or "new" for a chat the server is about to create. */
  key: string;
  url: string;
  body: unknown;
  onThread?: (thread: Thread) => void;
}

/** Runs one streamed request (send, retry, approve...) and folds its events into the cache and store. */
export async function startStream({ key: initialKey, url, body, onThread }: StartOptions) {
  let key = initialKey;
  const ac = new AbortController();
  controllers.set(key, ac);
  setLive(key, { busy: true, draft: [], error: null });
  try {
    await readEvents(url, body, ac.signal, (event, raw) => {
      const data = raw as Record<string, unknown>;
      switch (event) {
        case "thread": {
          const thread = data as unknown as Thread;
          // Move the live state from "new" to the real id before anyone renders it.
          lives.set(thread.id, lives.get(key) ?? { busy: true, draft: [], error: null });
          lives.delete(key);
          controllers.set(thread.id, ac);
          controllers.delete(key);
          key = thread.id;
          queryClient.setQueryData<ThreadData>(threadKey(thread.id), { thread: { ...thread, status: "running" }, messages: [], actions: [], limit: { max_messages: 50, used: 0, reached: false } });
          queryClient.setQueryData<{ items: Thread[] }>(THREADS_KEY, (d) => ({ items: [thread, ...(d?.items ?? []).filter((t) => t.id !== thread.id)] }));
          onThread?.(thread);
          listeners.forEach((l) => l());
          break;
        }
        case "task":
          toast.success(`Chat created with a ${String(data.frequency)} recurring task`);
          void queryClient.invalidateQueries({ queryKey: TASKS_KEY });
          break;
        case "message": {
          const m = data as unknown as ChatMessage;
          patchThread(key, (d) => ({ ...d, messages: upsert(d.messages, m), limit: m.role === "user" ? { ...d.limit, used: d.limit.used + 1 } : d.limit }));
          if (m.role === "assistant") setLive(key, { draft: [] });
          break;
        }
        case "block":
          setLive(key, (l) => ({ draft: [...l.draft, { index: Number(data.index), type: data.type as DraftBlock["type"], text: "", name: data.name as string | undefined, working: data.working as string | undefined }] }));
          break;
        case "text":
          setLive(key, (l) => ({ draft: l.draft.map((b) => (b.index === Number(data.index) && b.type === "text" ? { ...b, text: b.text + String(data.delta) } : b)) }));
          break;
        case "action": {
          const a = data as unknown as ChatAction;
          patchThread(key, (d) => ({ ...d, actions: upsert(d.actions, a) }));
          break;
        }
        case "suggestions":
          patchThread(key, (d) => ({ ...d, messages: d.messages.map((m) => (m.id === data.message_id ? { ...m, suggestions: data.items as string[] } : m)) }));
          break;
        case "reset":
          setLive(key, { draft: [] });
          break;
        case "truncate":
          patchThread(key, (d) => {
            const at = d.messages.findIndex((m) => m.id === data.after);
            const dropped = new Set(d.messages.slice(at + 1).map((m) => m.id));
            return { ...d, messages: d.messages.slice(0, at + 1), actions: d.actions.filter((a) => !dropped.has(a.message_id)) };
          });
          break;
        case "error":
          setLive(key, { error: String(data.message ?? "Something went wrong") });
          break;
        case "done":
          patchThread(key, (d) => ({ ...d, thread: { ...d.thread, status: (data.status as Thread["status"]) ?? "idle" } }));
          break;
      }
    });
  } catch (err) {
    if ((err as Error).name !== "AbortError") setLive(key, { error: err instanceof Error ? err.message : "Something went wrong" });
  } finally {
    controllers.delete(key);
    setLive(key, { busy: false, draft: [] });
    void queryClient.invalidateQueries({ queryKey: THREADS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["copilot-stats"] });
    if (key !== "new") void queryClient.invalidateQueries({ queryKey: threadKey(key) });
  }
  return key;
}

/** Stops the answer in progress (the server keeps what was written so far). */
export async function stopStream(threadId: string) {
  await fetch(`/api/app/copilot/threads/${threadId}/stop`, { method: "POST", headers: { "x-rs-csrf": "1", "content-type": "application/json" }, body: "{}", credentials: "same-origin" }).catch(() => undefined);
}

/** Current streaming state outside React (to check how a send ended). */
export const liveOf = (key: string): Live => lives.get(key) ?? EMPTY;

export function clearError(key: string) {
  setLive(key, { error: null });
}
