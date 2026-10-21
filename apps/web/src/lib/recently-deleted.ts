// Deleted campaigns, lead lists, leads, templates and subsequences wait in Settings → Recently deleted for 30 days.
// Delete dialogs say so, and the toast after a delete offers Undo, which puts the item back right away.
import { toast } from "sonner";
import { errorMessage, post } from "./api";
import { queryClient } from "./query";

export const RECENTLY_DELETED_PATH = "/app/settings/recently-deleted";

/** The sentence delete dialogs end with. */
export const restorable = (many = false) => `You can restore ${many ? "them" : "it"} from Recently deleted for 30 days.`;

export interface RestoreResult {
  kind: "campaign" | "lead_list" | "leads" | "template" | "subsequence";
  item_id: string | null;
  name: string;
  /** What happened, in a sentence or two. */
  message: string;
  /** Where the restored item is in the app. */
  link: string | null;
  counts: Record<string, number>;
}

/** Restores one entry. What comes back can show up anywhere (lists, counts, analytics), so everything on screen reloads. */
export async function restoreDeleted(entryId: string): Promise<RestoreResult> {
  const r = await post<RestoreResult>(`/api/app/recently-deleted/${entryId}/restore`);
  await queryClient.invalidateQueries();
  return r;
}

async function undo(ids: string[]) {
  try {
    const results: RestoreResult[] = [];
    for (const id of ids) results.push(await restoreDeleted(id));
    if (results.length === 1) toast.success(results[0]!.message);
    else if (results.every((r) => r.kind === "campaign")) toast.success(`${results.length} campaigns are back. They're paused, so nothing is sent until you resume them.`);
    else toast.success(`${results.length} items are back.`);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

/**
 * The toast after a delete: what went, that it can come back, and Undo when the server kept it. `many` is for one entry
 * that holds several things (a bulk lead delete).
 */
export function deletedToast(message: string, entryIds: string | null | undefined | Array<string | null | undefined>, many?: boolean) {
  const ids = (Array.isArray(entryIds) ? entryIds : [entryIds]).filter((id): id is string => !!id);
  if (!ids.length) return void toast.success(message);
  toast.success(message, {
    description: restorable(many ?? ids.length > 1),
    duration: 8000,
    action: { label: "Undo", onClick: () => void undo(ids) },
  });
}
