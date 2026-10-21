import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { APP_VARIABLES, LEAD_EDIT_FIELDS, isLeadFieldName } from "@reachstack/shared";
import { errorMessage, get, post } from "@/lib/api";
import { waitForJob, type Job } from "@/lib/jobs";
import { num, plural } from "@/lib/format";
import { Button, Dialog, Field, Input, NativeSelect, Progress, Segmented, Textarea } from "@/components/ui";

const NEW_VARIABLE = "new";

/** The variable name someone typed, or why it can't be one. */
function variableProblem(name: string): string | null {
  if (!name) return null;
  if (/[{}|]/.test(name)) return "A variable name can't have { } or | in it.";
  if (isLeadFieldName(name)) return "That's one of the lead's own fields: choose it from the list instead.";
  if (Object.hasOwn(APP_VARIABLES, name)) return "The app uses that name for something else; pick another.";
  return null;
}

/** Sets one field or custom variable, or clears it, for the selected leads. */
export function EditFieldDialog({
  open,
  onOpenChange,
  target,
  count,
  campaignId,
  listId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  target: Record<string, unknown>;
  count: number;
  campaignId?: string;
  listId?: string;
}) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [mode, setMode] = useState<"set" | "clear">("set");
  const [value, setValue] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const variables = useQuery({
    queryKey: ["lead-variables", campaignId ?? null, listId ?? null],
    queryFn: () => get<{ keys: string[] }>("/api/app/leads/variables", { campaign_id: campaignId, list_id: listId }),
    enabled: open,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (open) {
      setChoice("");
      setNewName("");
      setMode("set");
      setValue("");
      setProgress(null);
    }
  }, [open]);

  const field = LEAD_EDIT_FIELDS.find((f) => f.value === choice);
  const variable = choice === NEW_VARIABLE ? newName.trim() : choice.startsWith("var:") ? choice.slice(4) : "";
  const name = field ? field.label : variable ? `{{${variable}}}` : "";
  const problem = choice === NEW_VARIABLE ? variableProblem(newName.trim()) : null;
  const ready = !!name && !problem && (mode === "clear" || !!value.trim());
  const leads = plural(count, "lead");

  const run = async () => {
    setProgress(0);
    try {
      const body = { ...target, ...(field ? { field: field.value } : { variable }), value: mode === "clear" ? null : value };
      const r = await post<{ count: number; job: Job | null }>("/api/app/leads/edit", body);
      if (r.job) {
        const done = await waitForJob(r.job.id, setProgress);
        if (done.status !== "success") throw new Error(done.error ?? "The change couldn't be made");
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ["leads"] }), qc.invalidateQueries({ queryKey: ["lead"] }), qc.invalidateQueries({ queryKey: ["lead-variables"] })]);
      toast.success(`${name} ${mode === "clear" ? "cleared" : "set"} for ${plural(r.count, "lead")}`);
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
      setProgress(null);
    }
  };

  const keys = variables.data?.keys.filter((k) => !isLeadFieldName(k) && !Object.hasOwn(APP_VARIABLES, k)) ?? [];
  const options = [
    { value: "", label: "Choose a field…" },
    { group: "Lead fields", options: LEAD_EDIT_FIELDS.map((f) => ({ value: f.value, label: f.label })) },
    { group: "Custom variables", options: [...keys.map((k) => ({ value: `var:${k}`, label: `{{${k}}}` })), { value: NEW_VARIABLE, label: "New custom variable…" }] },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => progress === null && onOpenChange(v)}
      title={`Edit ${num(count)} lead${count === 1 ? "" : "s"}`}
      description="Set one field to the same value for every selected lead, or clear it. What they have there now is replaced."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={progress !== null}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={progress !== null} onClick={run}>
            {mode === "clear" ? `Clear for ${leads}` : `Update ${leads}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Field"
          hint={
            <>
              To rename or delete a custom variable for every lead, use{" "}
              <Link to="/app/settings/custom-variables" className="text-brand-text hover:underline">
                Settings → Custom variables
              </Link>
              .
            </>
          }
        >
          {(id) => <NativeSelect id={id} value={choice} onChange={setChoice} options={options} />}
        </Field>
        {choice === NEW_VARIABLE && (
          <Field label="Variable name" hint={!problem && newName.trim() ? `Use it in emails as {{${newName.trim()}}}.` : undefined} error={problem}>
            {(id) => <Input id={id} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="industry" maxLength={64} autoFocus invalid={!!problem} />}
          </Field>
        )}
        <Segmented
          value={mode}
          onChange={setMode}
          aria-label="Set or clear"
          options={[
            { value: "set", label: "Set to" },
            { value: "clear", label: "Clear it" },
          ]}
        />
        {mode === "set" ? (
          <Field
            label="New value"
            hint={field?.value === "timezone" ? "A name like America/New_York, an abbreviation like EST, or an offset like UTC+2." : undefined}
          >
            {(id) =>
              field?.value === "personalization" ? (
                <Textarea id={id} rows={4} value={value} onChange={(e) => setValue(e.target.value)} maxLength={10_000} />
              ) : (
                <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} maxLength={10_000} />
              )
            }
          </Field>
        ) : (
          <p className="text-sm text-muted">
            {field?.value === "timezone"
              ? "Each lead's timezone is worked out again from their location, phone or custom fields; leads it can't place go by the schedule's timezone."
              : name
                ? `${name} is left empty for ${leads}.`
                : "Choose the field to clear."}
          </p>
        )}
        {progress !== null && progress > 0 && <Progress value={progress} />}
      </div>
    </Dialog>
  );
}
