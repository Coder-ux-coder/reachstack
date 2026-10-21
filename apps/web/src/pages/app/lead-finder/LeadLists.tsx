import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ListPlus, Pencil, Plus, Search, Trash2, UserSearch, Users } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { ago, num, plural } from "@/lib/format";
import { deletedToast, restorable } from "@/lib/recently-deleted";
import { usePageTitle } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/cn";
import { LeadsTable } from "@/components/leads/LeadsTable";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Field, Input, LinkTabs, MenuItem, NativeSelect, RowMenu, SearchInput, Skeleton, useConfirm } from "@/components/ui";
import { LEAD_FINDER_TABS } from "./shared";

interface LeadList {
  id: string;
  name: string;
  has_enrichment_task: boolean | null;
  timestamp_created: string;
  lead_count: number;
}

const LISTS_KEY = ["lead-lists", "overview"];

function NameDialog({ open, onOpenChange, list }: { open: boolean; onOpenChange: (v: boolean) => void; list: LeadList | null }) {
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(list?.name ?? "");
  }, [open, list]);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (list) await patch(`/api/v2/lead-lists/${list.id}`, { name: name.trim() });
      else {
        const created = await post<LeadList>("/api/v2/lead-lists", { name: name.trim() });
        setParams({ list: created.id });
      }
      await qc.invalidateQueries({ queryKey: ["lead-lists"] });
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
      title={list ? "Rename list" : "New lead list"}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            {list ? "Save" : "Create list"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">{(id) => <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Heads of sales, US" />}</Field>
      </form>
    </Dialog>
  );
}

export default function LeadLists() {
  usePageTitle("Lead lists");
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<LeadList | null | "new">(null);
  const writable = can.perm("leads") && can.write;

  const lists = useQuery({ queryKey: LISTS_KEY, queryFn: () => get<{ total_in_lists: number; items: LeadList[] }>("/api/app/lead-lists/overview") });
  const items = lists.data?.items ?? [];
  const shown = items.filter((l) => l.name.toLowerCase().includes(search.trim().toLowerCase()));
  const current = items.find((l) => l.id === params.get("list")) ?? items[0] ?? null;
  const select = (id: string) => setParams({ list: id });

  const remove = async (l: LeadList) => {
    const ok = await confirm({
      title: `Delete “${l.name}”?`,
      description: l.lead_count ? `Its ${plural(l.lead_count, "lead")} go with it. ${restorable()}` : restorable(),
      confirmLabel: "Delete list",
      danger: true,
      ...(l.lead_count > 100 ? { typeToConfirm: "DELETE" } : {}),
    });
    if (!ok) return;
    try {
      const r = await del<{ recently_deleted_id?: string }>(`/api/v2/lead-lists/${l.id}`);
      if (current?.id === l.id) setParams({});
      await qc.invalidateQueries({ queryKey: ["lead-lists"] });
      await qc.invalidateQueries({ queryKey: ["leads"] });
      deletedToast("List deleted", r.recently_deleted_id);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line bg-panel px-4 pt-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Lead Finder</h1>
          {lists.data && <span className="text-xs text-muted">{plural(lists.data.total_in_lists, "lead")} across {plural(items.length, "list")}</span>}
          {writable && (
            <Button size="sm" className="ml-auto" icon={<Plus size={14} />} onClick={() => setEditing("new")}>
              New list
            </Button>
          )}
        </div>
        <LinkTabs tabs={LEAD_FINDER_TABS} className="mt-2 border-b-0" />
      </div>

      {lists.isLoading ? (
        <div className="space-y-3 p-6">
          <Skeleton className="h-10" />
          <Skeleton className="h-64" />
        </div>
      ) : !items.length ? (
        <EmptyState
          className="m-6 rounded-xl border border-dashed border-line-strong bg-panel py-14"
          icon={<ListPlus size={24} />}
          title="No lead lists yet"
          description="Lists hold leads before they go into a campaign. Add people from a Lead Finder search, import a CSV into a list, or start an empty one."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <ButtonLink to="/app/lead-finder" variant="primary" icon={<UserSearch size={14} />}>
                Find leads
              </ButtonLink>
              {writable && (
                <Button icon={<Plus size={14} />} onClick={() => setEditing("new")}>
                  New list
                </Button>
              )}
            </div>
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="scroll-thin hidden w-72 shrink-0 overflow-y-auto border-r border-line bg-panel p-3 md:block">
            <SearchInput value={search} onChange={setSearch} placeholder="Search lists" className="mb-2 w-full" />
            <nav aria-label="Lead lists" className="space-y-0.5">
              {shown.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => select(l.id)}
                  aria-current={current?.id === l.id ? "page" : undefined}
                  className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-panel-2", current?.id === l.id && "bg-brand-soft/60 text-brand-text hover:bg-brand-soft/60")}
                >
                  <Users size={14} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{l.name}</span>
                  <span className="text-xs tabular-nums text-muted">{num(l.lead_count)}</span>
                </button>
              ))}
              {!shown.length && (
                <p className="flex items-center gap-1.5 px-2.5 py-4 text-xs text-muted">
                  <Search size={12} /> No list matches “{search}”.
                </p>
              )}
            </nav>
          </aside>

          {current && (
            <section className="scroll-thin min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <div className="mb-4 md:hidden">
                <NativeSelect value={current.id} onChange={select} options={items.map((l) => ({ value: l.id, label: `${l.name} (${num(l.lead_count)})` }))} aria-label="Lead list" />
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 truncate text-base font-semibold">
                    {current.name}
                    {current.has_enrichment_task && <Badge tone="info">Enrichment on</Badge>}
                  </h2>
                  <p className="text-xs text-muted">
                    {plural(current.lead_count, "lead")} · created {ago(current.timestamp_created)}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <ButtonLink to="/app/lead-finder" size="sm" icon={<UserSearch size={14} />}>
                    Find more leads
                  </ButtonLink>
                  {writable && (
                    <RowMenu label="List actions">
                      <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(current)}>
                        Rename
                      </MenuItem>
                      <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => remove(current)}>
                        Delete list
                      </MenuItem>
                    </RowMenu>
                  )}
                </div>
              </div>
              <LeadsTable key={current.id} listId={current.id} />
            </section>
          )}
        </div>
      )}

      <NameDialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)} list={editing === "new" ? null : editing} />
    </div>
  );
}
