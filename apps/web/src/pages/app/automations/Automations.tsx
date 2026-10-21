// Automations list: status toggles, apps, last change and run counts, plus creating, duplicating and deleting.
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Copy, History, Pencil, Play, Plus, Trash2, Workflow } from "lucide-react";
import { errorMessage, get, post, del } from "@/lib/api";
import { ago, num } from "@/lib/format";
import { usePageTitle, useQueryState } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { Badge, Button, ButtonLink, DataTable, Dialog, EmptyState, Field, Input, MenuItem, MenuSeparator, Page, PageHeader, RowMenu, SearchInput, Select, Switch, Textarea, Tooltip, useConfirm, type Column } from "@/components/ui";
import { BASE, keys, type Automation, type AutomationSummary } from "./api";
import { AppIcon, useAppLabel } from "./ui";

type Sort = "updated" | "name_asc" | "name_desc";

export function NewAutomationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  // Enter pressed twice before the first answer would make two.
  const creating = useRef(false);
  const create = async () => {
    if (!name.trim() || creating.current) return;
    creating.current = true;
    setBusy(true);
    try {
      const row = await post<Automation>(BASE, { name: name.trim(), description: description.trim() || null });
      await qc.invalidateQueries({ queryKey: keys.list });
      onOpenChange(false);
      setName("");
      setDescription("");
      navigate(`/app/automations/${row.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New automation"
      description="Give it a name; you'll pick what starts it and what it does next."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={create} loading={busy} disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          {(id) => <Input id={id} autoFocus value={name} maxLength={120} placeholder="e.g. Tell sales about interested replies" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && create()} />}
        </Field>
        <Field label="Description" optional>
          {(id) => <Textarea id={id} rows={3} value={description} maxLength={2000} placeholder="What it's for, so teammates know" onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

export default function Automations() {
  usePageTitle("Automations");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const can = useCan();
  const appLabel = useAppLabel();
  const [search, setSearch] = useQueryState("search");
  const [status, setStatus] = useQueryState("status");
  const [sort, setSort] = useQueryState("sort", "updated");
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const q = useQuery({ queryKey: keys.list, queryFn: () => get<{ items: AutomationSummary[] }>(BASE) });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (q.data?.items ?? []).filter((a) => (!status || a.status === status) && (!needle || a.name.toLowerCase().includes(needle) || (a.description ?? "").toLowerCase().includes(needle)));
    const by = sort as Sort;
    return list.sort((a, b) => (by === "name_asc" ? a.name.localeCompare(b.name) : by === "name_desc" ? b.name.localeCompare(a.name) : b.timestamp_updated.localeCompare(a.timestamp_updated)));
  }, [q.data, search, status, sort]);

  const refresh = () => qc.invalidateQueries({ queryKey: keys.list });
  const setActive = async (a: AutomationSummary, on: boolean) => {
    setToggling(a.id);
    try {
      await post(`${BASE}/${a.id}/status`, { status: on ? "active" : "paused" });
      await refresh();
      toast.success(on ? `“${a.name}” is on` : `“${a.name}” is off`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setToggling(null);
    }
  };
  const duplicate = async (a: AutomationSummary) => {
    try {
      const copy = await post<Automation>(`${BASE}/${a.id}/duplicate`);
      await refresh();
      toast.success("Automation duplicated", { action: { label: "Open", onClick: () => navigate(`/app/automations/${copy.id}`) } });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (a: AutomationSummary) => {
    const ok = await confirm({ title: `Delete “${a.name}”?`, description: "The automation and its run history are deleted. Runs that are waiting stop. This can't be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await del(`${BASE}/${a.id}`);
      await refresh();
      toast.success("Automation deleted");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const runNow = async (a: AutomationSummary) => {
    try {
      await post(`${BASE}/${a.id}/run`);
      toast.success("Run started", { action: { label: "History", onClick: () => navigate(`/app/automations/history?workflow_id=${a.id}`) } });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const columns: Column<AutomationSummary>[] = [
    {
      key: "name",
      header: "Name",
      cell: (a) => (
        <div className="min-w-0 max-w-md">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{a.name}</span>
            {a.problems > 0 && (
              <Tooltip content="Open the automation to see what needs fixing.">
                <span>
                  <Badge tone="warn">
                    <AlertTriangle size={11} />
                    {a.problems === 1 ? "1 problem" : `${a.problems} problems`}
                  </Badge>
                </span>
              </Tooltip>
            )}
          </div>
          {a.description && <p className="mt-0.5 truncate text-xs text-muted">{a.description}</p>}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (a) => {
        const blocked = a.status !== "active" && a.problems > 0;
        return (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Tooltip content={blocked ? "Fix the problems in the editor to turn it on." : a.status === "active" ? "Turn off" : "Turn on"}>
              <span>
                <Switch size="sm" checked={a.status === "active"} disabled={!can.write || blocked || toggling === a.id} onChange={(v) => setActive(a, v)} aria-label={`${a.name} on or off`} />
              </span>
            </Tooltip>
            <span className="text-xs text-muted">{a.status === "active" ? "Active" : a.status === "draft" ? "Draft" : "Off"}</span>
          </div>
        );
      },
    },
    {
      key: "apps",
      header: "Apps",
      hideBelow: "sm",
      cell: (a) =>
        a.apps.length ? (
          <div className="flex items-center gap-1">
            {a.apps.map((k) => (
              <Tooltip key={k} content={appLabel(k)}>
                <span>
                  <AppIcon app={k} size={22} />
                </span>
              </Tooltip>
            ))}
          </div>
        ) : (
          <span className="text-faint">–</span>
        ),
    },
    { key: "updated", header: "Last modified", hideBelow: "md", cell: (a) => <span className="text-muted">{ago(a.timestamp_updated)}</span> },
    {
      key: "runs",
      header: "Runs",
      cell: (a) => (
        <Link to={`/app/automations/history?workflow_id=${a.id}`} onClick={(e) => e.stopPropagation()} className="tabular-nums hover:underline">
          {num(a.run_count)}
        </Link>
      ),
    },
    {
      key: "menu",
      header: <span className="sr-only">Actions</span>,
      className: "w-10 text-right",
      cell: (a) => (
        <RowMenu>
          <MenuItem icon={<Pencil size={14} />} onSelect={() => navigate(`/app/automations/${a.id}`)}>
            Edit
          </MenuItem>
          {a.trigger_type === "manual" && (
            <MenuItem icon={<Play size={14} />} disabled={a.status !== "active" || !can.write} onSelect={() => runNow(a)}>
              Run now
            </MenuItem>
          )}
          <MenuItem icon={<History size={14} />} onSelect={() => navigate(`/app/automations/history?workflow_id=${a.id}`)}>
            History
          </MenuItem>
          <MenuItem icon={<Copy size={14} />} disabled={!can.write} onSelect={() => duplicate(a)}>
            Duplicate
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} />} danger disabled={!can.write} onSelect={() => remove(a)}>
            Delete
          </MenuItem>
        </RowMenu>
      ),
    },
  ];

  const filtered = !!(search || status);
  return (
    <Page>
      <PageHeader
        title="Automations"
        description="Run steps for you when something happens: a lead replies, clicks or finishes a sequence, a campaign changes, a request arrives."
        actions={
          <>
            <ButtonLink to="/app/automations/history" icon={<History size={15} />}>
              History
            </ButtonLink>
            {can.write && (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                Add new
              </Button>
            )}
          </>
        }
      />
      {(q.data?.items.length ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={setSearch} placeholder="Search automations" className="w-full sm:w-64" />
          <Select
            size="sm"
            className="w-36"
            aria-label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: "All statuses" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Off" },
              { value: "draft", label: "Draft" },
            ]}
          />
          <Select
            size="sm"
            className="w-44"
            aria-label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: "updated", label: "Recently modified" },
              { value: "name_asc", label: "Name A–Z" },
              { value: "name_desc", label: "Name Z–A" },
            ]}
          />
        </div>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(a) => a.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        onRowClick={(a) => navigate(`/app/automations/${a.id}`)}
        empty={
          filtered ? (
            <EmptyState title="No automations match" description="Try another search or status." />
          ) : (
            <EmptyState
              icon={<Workflow size={22} />}
              title="No automations yet"
              description="Pick what starts an automation (a reply, a click, a schedule, a webhook…), then add the steps it should take."
              action={
                can.write && (
                  <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                    Add new
                  </Button>
                )
              }
            />
          )
        }
      />
      <NewAutomationDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
