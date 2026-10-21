import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Tag as TagIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, get, post, type Page } from "@/lib/api";
import type { Tag } from "@/lib/types";
import { Button, Input, Popover } from "@/components/ui";
import { cn } from "@/lib/cn";

export const TAGS_KEY = ["custom-tags"] as const;

export function useTags() {
  return useQuery({ queryKey: TAGS_KEY, queryFn: () => get<Page<Tag>>("/api/v2/custom-tags", { limit: 100 }), select: (d) => d.items });
}

export function TagChip({ tag }: { tag: Tag }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color || "var(--faint)" }} />
      {tag.label}
    </span>
  );
}

/** Multi-select tag list with inline creation. */
export function TagPicker({
  value,
  onChange,
  trigger,
  title = "Tags",
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  trigger?: React.ReactNode;
  title?: string;
}) {
  const tags = useTags();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const shown = (tags.data ?? []).filter((t) => t.label.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = (tags.data ?? []).some((t) => t.label.toLowerCase() === q.trim().toLowerCase());
  const create = async () => {
    try {
      const t = await post<Tag>("/api/v2/custom-tags", { label: q.trim() });
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
      onChange([...value, t.id]);
      setQ("");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Popover
      className="w-64 p-2"
      trigger={
        trigger ?? (
          <Button size="sm" icon={<TagIcon size={14} />}>
            {value.length ? `${value.length} tag${value.length === 1 ? "" : "s"}` : title}
          </Button>
        )
      }
    >
      <Input inputSize="sm" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search or create…" />
      <div className="scroll-thin mt-2 max-h-56 overflow-y-auto">
        {shown.map((t) => {
          const on = value.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-panel-2"
            >
              <span className={cn("flex h-4 w-4 items-center justify-center rounded border", on ? "border-brand bg-brand text-on-brand" : "border-line-strong")}>{on && <Check size={11} strokeWidth={3} />}</span>
              <span className="h-2 w-2 rounded-full" style={{ background: t.color || "var(--faint)" }} />
              <span className="flex-1 truncate">{t.label}</span>
            </button>
          );
        })}
        {!shown.length && !q && <p className="px-2 py-3 text-center text-xs text-muted">No tags yet. Type a name to create one.</p>}
      </div>
      {q.trim() && !exact && (
        <Button size="sm" variant="ghost" className="mt-1 w-full justify-start" icon={<Plus size={14} />} onClick={create}>
          Create "{q.trim()}"
        </Button>
      )}
    </Popover>
  );
}
