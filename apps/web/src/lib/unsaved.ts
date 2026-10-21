import { useCallback, useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useBlocker, type Location } from "react-router";
import { useConfirm } from "@/components/ui";

type Place = Pick<Location, "pathname" | "search">;

/**
 * Where a form's edits stay open: a path prefix (tabs of one form), or a test of the next location (a panel opened by
 * a query parameter, which the browser's Back button closes without changing the page).
 */
export type StayWithin = string | ((next: Place) => boolean);

interface Guard {
  dirty: boolean;
  description: string;
  stayWithin?: StayWithin;
}

/** Every mounted form's guard. React Router keeps only one blocker, so forms register here and one blocker reads them all. */
const guards = new Map<string, Guard>();

const DEFAULT_DESCRIPTION = "Your changes haven't been saved yet.";

/** The first guard with unsaved edits that going from `current` to `next` would leave, if any. */
function blockingGuard(current: Place, next: Place): Guard | undefined {
  for (const g of guards.values()) {
    if (!g.dirty) continue;
    const stays =
      typeof g.stayWithin === "function" ? g.stayWithin(next) : next.pathname === current.pathname || (!!g.stayWithin && next.pathname.startsWith(g.stayWithin));
    if (!stays) return g;
  }
  return undefined;
}

/**
 * Asks before leaving the page (in-app navigation or closing the tab) while there are unsaved edits.
 * `stayWithin`: where the edits stay open (see StayWithin); by default, the same page.
 * Needs <UnsavedChangesPrompt /> mounted once inside the router.
 */
export function useUnsavedChanges(dirty: boolean, description = DEFAULT_DESCRIPTION, stayWithin?: StayWithin) {
  const id = useId();
  useEffect(() => {
    guards.set(id, { dirty, description, stayWithin });
    return () => {
      guards.delete(id);
    };
  }, [id, dirty, description, stayWithin]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

/** Asks whether to throw away unsaved edits; true to go ahead. For what no route change guards, like closing a panel. */
export function useConfirmDiscard() {
  const confirm = useConfirm();
  return useCallback((description = DEFAULT_DESCRIPTION) => confirm({ title: "Leave without saving?", description, confirmLabel: "Discard changes", danger: true }), [confirm]);
}

/** The one router blocker behind every useUnsavedChanges: confirms before in-app navigation leaves unsaved edits. */
export function UnsavedChangesPrompt() {
  // What the blocked navigation would leave, found when it was blocked (the page hasn't changed yet).
  const leaving = useRef<Guard | undefined>(undefined);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    leaving.current = blockingGuard(currentLocation, nextLocation);
    return !!leaving.current;
  });
  const confirmDiscard = useConfirmDiscard();

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirmDiscard(leaving.current?.description).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker, confirmDiscard]);

  return null;
}

/** Saves a form's edits: false when they couldn't be saved (the form says why). */
export type SaveEdits = () => Promise<boolean>;

/**
 * While there are unsaved edits, hands `report` a way to save them (and null once there are none), so the page around
 * the form can save them before it acts on what's saved, like a campaign's Launch.
 */
export function useReportUnsaved(dirty: boolean, save: SaveEdits, report: ((save: SaveEdits | null) => void) | undefined) {
  const latest = useRef({ save, report });
  latest.current = { save, report };
  useEffect(() => {
    if (!dirty) return;
    latest.current.report?.(() => latest.current.save());
    return () => latest.current.report?.(null);
  }, [dirty]);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A draft started from `from`, moved onto `to`: what was edited stays, field by field, and the rest follows `to`. */
export function rebase<T>(draft: T, from: T, to: T): T {
  if (same(draft, from)) return to;
  if (!isRecord(draft) || !isRecord(from) || !isRecord(to)) return draft;
  return Object.fromEntries(Object.keys(to).map((k) => [k, rebase(draft[k], from[k], to[k])])) as T;
}

interface DraftState<T> {
  key: string;
  scope?: string;
  base: T;
  draft: T;
  /** What a save in flight sent. */
  sent?: { value: T };
}

/**
 * A form's working copy of saved values, and whether it differs from them. When the saved values change (a save, or a
 * reload after some other action) the fields edited here keep their edits and the rest take the new values; a new
 * `scope` (another record) starts over.
 *
 * `sending(value)` says what a save is sending (and `sending(undefined)` that it failed): when the saved values come
 * back, whatever wasn't touched since takes the saved form, and what was typed while it saved stays.
 */
export function useDraft<T>(saved: T, scope?: string): [T, Dispatch<SetStateAction<T>>, boolean, (sent: T | undefined) => void] {
  const key = JSON.stringify(saved);
  const [state, setState] = useState<DraftState<T>>({ key, scope, base: saved, draft: saved });
  let current = state;
  if (state.key !== key || state.scope !== scope) {
    // Adjusted while rendering, so the old record's values never show for a frame.
    const from = state.sent ? state.sent.value : state.base;
    current = { key, scope, base: saved, draft: state.scope === scope ? rebase(state.draft, from, saved) : saved };
    setState(current);
  }
  const setDraft = useCallback<Dispatch<SetStateAction<T>>>((next) => setState((s) => ({ ...s, draft: typeof next === "function" ? (next as (d: T) => T)(s.draft) : next })), []);
  const sending = useCallback((sent: T | undefined) => setState((s) => ({ ...s, sent: sent === undefined ? undefined : { value: sent } })), []);
  return [current.draft, setDraft, JSON.stringify(current.draft) !== key, sending];
}
