// Thin fetch wrapper for the server API: cookie session, CSRF header, JSON in and out, typed errors.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

export function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Told when an answer says the workspace first asks for two-step authentication or a fresh code (see RequireAuth). */
let gateListener: (() => void) | null = null;
export function onWorkspaceGate(fn: (() => void) | null) {
  gateListener = fn;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { "x-rs-csrf": "1" };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path + qs(opts.query), { method, headers, body, credentials: "same-origin", signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: string; code?: string; details?: unknown };
    if (d.code === "totp_required" || d.code === "workspace_reauth_required") gateListener?.();
    throw new ApiError(res.status, d.message || res.statusText || "Request failed", d.code, d.details);
  }
  return data as T;
}

export const get = <T = unknown>(path: string, query?: Query, signal?: AbortSignal) => api<T>(path, { query, signal });
export const post = <T = unknown>(path: string, body: unknown = {}, query?: Query) => api<T>(path, { method: "POST", body, query });
export const put = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "PUT", body });
export const patch = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "PATCH", body });
export const del = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: "DELETE", body });

/** The server said the record isn't there (a deleted record, an old link, an id from another workspace). */
export const isNotFound = (err: unknown) => err instanceof ApiError && (err.status === 404 || err.status === 400);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

export interface Page<T> {
  items: T[];
  next_starting_after?: string | null;
}
