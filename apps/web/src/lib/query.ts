import { QueryClient, useInfiniteQuery, useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, errorMessage, get, type Page, type Query } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

/** Cursor pagination over `{ items, next_starting_after }` endpoints. */
export function useCursorList<T>(key: QueryKey, path: string, query: Query = {}, opts: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  const q = useInfiniteQuery({
    queryKey: [...key, query],
    queryFn: ({ pageParam, signal }) => get<Page<T>>(path, { ...query, starting_after: (pageParam as string | undefined) ?? undefined }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_starting_after ?? undefined,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...q, items };
}

/** A mutation that shows a toast on success/failure and refreshes the given queries. */
export function useAction<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { success?: string | ((r: TResult, v: TVars) => string | null); invalidate?: QueryKey[]; onSuccess?: (r: TResult, v: TVars) => void; silentError?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, v) => {
      for (const key of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: key });
      const msg = typeof opts.success === "function" ? opts.success(r, v) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(r, v);
    },
    onError: (err) => {
      if (!opts.silentError) toast.error(errorMessage(err));
    },
  });
}
