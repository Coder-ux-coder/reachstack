import { useQuery, type QueryClient } from "@tanstack/react-query";
import { ApiError, get } from "./api";

export interface Job<R = Record<string, unknown>> {
  id: string;
  type: string;
  status: "pending" | "in-progress" | "success" | "failed" | "draining" | "paused" | "cancelled";
  progress: number;
  data: Record<string, unknown> | null;
  result: R | null;
  error: string | null;
  created_at: string;
}

const FINAL = new Set(["success", "failed", "cancelled"]);

export const jobDone = (j: Pick<Job, "status"> | undefined | null) => !!j && FINAL.has(j.status);

/** Jobs followJob is polling: useJob leaves those to it. */
const followed = new Set<string>();

/** Polls a background job until it finishes. */
export function useJob<R = Record<string, unknown>>(id: string | null | undefined) {
  return useQuery({
    queryKey: ["job", id],
    queryFn: () => get<Job<R>>(`/api/v2/background-jobs/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (jobDone(q.state.data as Job | undefined) || followed.has(id ?? "") ? false : 1000),
  });
}

/** How long to wait before asking about a job again: every second at first, less often for a long one. */
const nextPoll = (elapsed: number) => (elapsed < 120_000 ? 1_000 : elapsed < 600_000 ? 3_000 : 10_000);
/** A job that hasn't ended after this long is left to the page that lists jobs. */
const FOLLOW_AT_MOST = 12 * 3_600_000;

/**
 * Follows a job to the end even once nothing shows it (a closed dialog, another page), keeping useJob's data current,
 * then calls `onEnd` with the final job, or with null when the server stopped answering about it.
 */
export function followJob<R = Record<string, unknown>>(qc: QueryClient, id: string, onEnd: (job: Job<R> | null) => void) {
  if (followed.has(id)) return;
  followed.add(id);
  void (async () => {
    const started = Date.now();
    let misses = 0;
    try {
      for (;;) {
        try {
          const j = await get<Job<R>>(`/api/v2/background-jobs/${id}`);
          misses = 0;
          qc.setQueryData(["job", id], j);
          if (jobDone(j)) return onEnd(j);
        } catch (e) {
          // A restart or a dropped connection is waited out for a minute; a job that's gone isn't.
          if ((e instanceof ApiError && e.status >= 400 && e.status < 500) || ++misses >= 60) return onEnd(null);
        }
        if (Date.now() - started > FOLLOW_AT_MOST) return onEnd(null);
        await new Promise((r) => setTimeout(r, misses ? 1_000 : nextPoll(Date.now() - started)));
      }
    } finally {
      followed.delete(id);
    }
  })();
}

/** Waits for a job imperatively (exports, moves) and reports progress along the way. */
export async function waitForJob<R = Record<string, unknown>>(id: string, onProgress?: (progress: number) => void): Promise<Job<R>> {
  for (;;) {
    const j = await get<Job<R>>(`/api/v2/background-jobs/${id}`);
    onProgress?.(j.progress);
    if (jobDone(j)) return j;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
