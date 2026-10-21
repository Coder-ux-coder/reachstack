import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { Braces, Pencil, Trash2 } from "lucide-react";
import { APP_VARIABLES, isLeadFieldName } from "@reachstack/shared";
import { errorMessage, get, post } from "@/lib/api";
import { plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { waitForJob, type Job } from "@/lib/jobs";
import { useCan } from "@/lib/session";
import { Button, Card, Checkbox, Dialog, EmptyState, ErrorState, Field, Input, MenuItem, Progress, RowMenu, SearchInput, SkeletonRows, useConfirm } from "@/components/ui";
import { SettingsHeader } from "./parts";

interface Use {
  kind: "campaign" | "subsequence" | "template";
  id: string;
  name: string;
  campaign_id: string | null;
}

interface Variable {
  name: string;
  leads: number;
  example: string | null;
  used_in: Use[];
}

const KEY = ["lead-variables", "manage"];

const hrefOf = (u: Use) => (u.kind === "campaign" ? `/app/campaign/${u.id}/sequences` : u.kind === "subsequence" ? `/app/campaign/${u.campaign_id}/subsequences/${u.id}/sequences` : "/app/templates");
const KIND = { campaign: "campaign", subsequence: "subsequence", template: "template" } as const;

/** "Used in Welcome (campaign), Follow-up (template) and 2 more". */
function UsedIn({ uses }: { uses: Use[] }) {
  if (!uses.length) return <p className="mt-0.5 text-xs text-faint">Not used in any email</p>;
  const shown = uses.slice(0, 3);
  return (
    <p className="mt-0.5 text-xs text-muted">
      Used in{" "}
      {shown.map((u, i) => (
        <span key={`${u.kind}:${u.id}`}>
          {i > 0 && (i === shown.length - 1 && uses.length === shown.length ? " and " : ", ")}
          <Link to={hrefOf(u)} className="text-text underline-offset-2 hover:underline">
            {u.name}
          </Link>{" "}
          <span className="text-faint">({KIND[u.kind]})</span>
        </span>
      ))}
      {uses.length > shown.length && ` and ${uses.length - shown.length} more`}
    </p>
  );
}

/** A name a variable can take, or why not. */
function nameProblem(name: string, current: string): string | null {
  if (!name || name === current) return null;
  if (/[{}|]/.test(name)) return "A variable name can't have { } or | in it.";
  if (isLeadFieldName(name)) return "That's one of the lead's own fields; pick another name.";
  if (Object.hasOwn(APP_VARIABLES, name)) return "The app uses that name for something else; pick another.";
  return null;
}

function RenameDialog({ variable, all, onClose }: { variable: Variable | null; all: Variable[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [emails, setEmails] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    if (!variable) return;
    setName(variable.name);
    setEmails(true);
    setProgress(null);
  }, [variable]);
  if (!variable) return <Dialog open={false} onOpenChange={() => onClose()} title="" />;
  const to = name.trim();
  const problem = nameProblem(to, variable.name);
  const existing = all.find((v) => v.name === to && v.name !== variable.name);
  const uses = variable.used_in.length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!to || problem || to === variable.name) return;
    setProgress(0);
    try {
      const r = await post<{ leads: number; emails: number | null; job: Job | null }>("/api/app/lead-variables/rename", { name: variable.name, to, emails: emails && uses > 0 });
      let changed = r.emails;
      if (r.job) {
        const done = await waitForJob<{ emails: number }>(r.job.id, setProgress);
        if (done.status !== "success") throw new Error(done.error ?? "The rename couldn't be finished");
        changed = done.result?.emails ?? 0;
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ["lead-variables"] }), qc.invalidateQueries({ queryKey: ["leads"] }), qc.invalidateQueries({ queryKey: ["lead"] })]);
      toast.success(`{{${variable.name}}} is now {{${to}}} for ${plural(r.leads, "lead")}${changed ? ` and in ${plural(changed, "email")}` : ""}`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
      setProgress(null);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && progress === null && onClose()}
      title={`Rename {{${variable.name}}}`}
      description={`It's renamed on the ${plural(variable.leads, "lead")} that have it.`}
      footer={
        <>
          <Button onClick={onClose} disabled={progress !== null}>
            Cancel
          </Button>
          <Button type="submit" form="rename-variable" variant="primary" loading={progress !== null} disabled={!to || !!problem || to === variable.name}>
            {existing ? "Merge" : "Rename"}
          </Button>
        </>
      }
    >
      <form id="rename-variable" onSubmit={submit} className="space-y-4">
        <Field
          label="New name"
          error={problem}
          hint={
            existing
              ? `{{${to}}} exists already (${plural(existing.leads, "lead")}): the two are merged. Leads that have a value in both keep their {{${to}}}.`
              : to && to !== variable.name
                ? `Emails use it as {{${to}}}.`
                : undefined
          }
        >
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus invalid={!!problem} />}
        </Field>
        {uses > 0 && (
          <Checkbox
            label={
              <span>
                Also change it in the {plural(uses, "email")} that use it
                <span className="block text-xs text-muted">Campaign and subsequence steps (their history keeps the version before) and templates.</span>
              </span>
            }
            checked={emails}
            onChange={setEmails}
          />
        )}
        {progress !== null && progress > 0 && <Progress value={progress} />}
      </form>
    </Dialog>
  );
}

/** /app/settings/custom-variables */
export default function CustomVariables() {
  usePageTitle("Custom variables");
  const can = useCan();
  const editable = can.write && can.perm("leads");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<Variable | null>(null);
  const q = useQuery({ queryKey: KEY, queryFn: () => get<{ items: Variable[] }>("/api/app/lead-variables") });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return s ? items.filter((v) => v.name.toLowerCase().includes(s) || v.example?.toLowerCase().includes(s)) : items;
  }, [items, search]);

  const remove = async (v: Variable) => {
    const uses = v.used_in.length;
    const ok = await confirm({
      title: `Delete {{${v.name}}}?`,
      description: `Its values are removed from ${plural(v.leads, "lead")}; this can't be undone.${uses ? ` ${plural(uses, "email")} still use it and will show their fallback there, or leave a gap.` : ""}`,
      confirmLabel: "Delete variable",
      danger: true,
      typeToConfirm: v.leads > 100 ? "DELETE" : undefined,
    });
    if (!ok) return;
    try {
      const r = await post<{ leads: number; job: Job | null }>("/api/app/lead-variables/delete", { name: v.name });
      if (r.job) {
        const done = await waitForJob(r.job.id);
        if (done.status !== "success") throw new Error(done.error ?? "The variable couldn't be removed from every lead");
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ["lead-variables"] }), qc.invalidateQueries({ queryKey: ["leads"] }), qc.invalidateQueries({ queryKey: ["lead"] })]);
      toast.success(`{{${v.name}}} deleted from ${plural(r.leads, "lead")}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Custom variables"
        description="Details your leads have beyond the standard fields: columns you imported, AI columns, enrichment and automations fill them in, and emails use them as {{name}}. Rename one to tidy up names from different files (renaming into a name that exists merges the two), or delete one you don't need."
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">Variables</h2>
          {items.length > 0 && <span className="text-xs text-muted">{items.length}</span>}
          {items.length > 8 && <SearchInput value={search} onChange={setSearch} placeholder="Search variables" className="w-full sm:ml-auto sm:w-56" />}
        </div>
        {q.isLoading ? (
          <SkeletonRows rows={4} />
        ) : q.error ? (
          <ErrorState title="Custom variables didn't load" error={q.error} onRetry={() => q.refetch()} />
        ) : !items.length ? (
          <EmptyState
            icon={<Braces size={22} />}
            title="No custom variables yet"
            description="Import a file with more columns than name and company and map them to custom variables, or add AI columns to your leads. They show up here."
          />
        ) : !shown.length ? (
          <EmptyState title="No variable matches" description="Try another search." action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((v) => (
              <li key={v.name} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <code className="break-all font-mono text-[13px] font-medium">{`{{${v.name}}}`}</code>
                    <span className="text-xs text-muted">{v.leads ? plural(v.leads, "lead") : "No values"}</span>
                  </div>
                  {v.example && <p className="mt-0.5 truncate text-[13px] text-muted">For example “{v.example}”</p>}
                  {Object.hasOwn(APP_VARIABLES, v.name) ? <p className="mt-0.5 text-xs text-muted">{APP_VARIABLES[v.name]} It can't be renamed or deleted.</p> : <UsedIn uses={v.used_in} />}
                </div>
                {editable && !Object.hasOwn(APP_VARIABLES, v.name) && (
                  <RowMenu label={`Actions for ${v.name}`}>
                    <MenuItem icon={<Pencil size={14} />} onSelect={() => setRenaming(v)}>
                      Rename or merge
                    </MenuItem>
                    <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => remove(v)}>
                      Delete
                    </MenuItem>
                  </RowMenu>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <RenameDialog variable={renaming} all={items} onClose={() => setRenaming(null)} />
    </div>
  );
}
