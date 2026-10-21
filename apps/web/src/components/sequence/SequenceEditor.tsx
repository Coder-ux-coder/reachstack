import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Copy, Eye, EyeOff, Mail, Plus, Save, Trash2 } from "lucide-react";
import {
  LINKEDIN_NOTE_MAX,
  TASK_STEPS,
  TASK_STEP_KINDS,
  isTaskStep,
  taskStepProblem,
  validateBraces,
  type SequenceStep,
  type SequenceVariant,
  type TaskStepKind,
} from "@reachstack/shared";
import { errorMessage, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useDraft, useReportUnsaved, useUnsavedChanges, type SaveEdits } from "@/lib/unsaved";
import { RichEditor, type RichEditorHandle } from "@/components/RichEditor";
import { Button, Callout, Card, Field, Input, Menu, MenuContent, MenuItem, MenuTrigger, NativeSelect, NumberInput, Textarea, Tooltip, useConfirm } from "@/components/ui";
import { AiSequenceDialog, AiToolsMenu, AiWriteDialog, PreviewDialog, SaveTemplateDialog, SpamCheckDialog, TemplatesPicker, VariablesMenu, useReplaceConfirm } from "./tools";
import { TaskIcon, defaultTaskTitle } from "./task-steps";
import { VersionsButton } from "./VersionsDialog";

const letter = (i: number) => String.fromCharCode(65 + i);
const blankVariant = (): SequenceVariant => ({ subject: "", body: "" });
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Normalised copy so comparisons ignore missing optional fields. A task step has one title and note. */
function normalize(steps: SequenceStep[]): SequenceStep[] {
  return steps.map((s) => {
    const task = isTaskStep(s);
    return {
      type: task ? "task" : "email",
      ...(task ? { task: s.task ?? "todo" } : {}),
      delay: s.delay ?? 0,
      delay_unit: s.delay_unit ?? "days",
      ...(s.pre_delay ? { pre_delay: s.pre_delay, pre_delay_unit: s.pre_delay_unit ?? "days" } : {}),
      variants: (task ? s.variants.slice(0, 1) : s.variants).map((v) => ({ subject: v.subject ?? "", body: v.body ?? "", ...(v.v_disabled && !task ? { v_disabled: true } : {}) })),
    };
  });
}

export interface SequenceEditorProps {
  steps: SequenceStep[];
  onSave: (steps: SequenceStep[]) => Promise<unknown>;
  /** Campaign used for previews, test emails and custom variables. */
  campaignId: string;
  customVariables?: string[];
  readOnly?: boolean;
  /** Launched campaigns warn before structural changes. */
  launched?: boolean;
  /** Subsequence steps: the first step may reuse the parent subject and can wait before sending. */
  subsequence?: boolean;
  textOnly?: boolean;
  /** Saved versions of this sequence ("Versions" button): whose they are, and how to reload once one is restored. */
  versions?: { path: string; onRestored: () => Promise<unknown> };
  /** Given a way to save while there are unsaved edits (null once there are none), so the page can save them first. */
  onUnsaved?: (save: SaveEdits | null) => void;
  /** Whose sequence this is (the campaign's by default): edits never carry over to another one's. */
  scope?: string;
}

export function SequenceEditor({ steps: saved, onSave, campaignId, customVariables = [], readOnly, launched, subsequence, textOnly, versions, onUnsaved, scope }: SequenceEditorProps) {
  const confirm = useConfirm();
  const confirmReplace = useReplaceConfirm();
  const baseline = useMemo(() => normalize(saved.length ? saved : [{ type: "email", delay: 2, delay_unit: "days", variants: [blankVariant()] }]), [saved]);
  // Follows the saved sequence: what's typed while it saves, or before a reload, stays.
  const [steps, setSteps, , sending] = useDraft<SequenceStep[]>(baseline, scope ?? campaignId);
  // The steps as they are now, for code that runs after waiting on the server (an AI answer).
  const stepsNow = useRef(steps);
  stepsNow.current = steps;
  const [sel, setSel] = useState({ step: 0, variant: 0 });
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<null | "ai-sequence" | "ai-write" | "spam" | "preview" | "save-template">(null);
  const [spinning, setSpinning] = useState(false);
  const editor = useRef<RichEditorHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // Where Variables inserts: the field the cursor was last in. Set by the fields' own focus, so opening the menu doesn't count.
  const [focus, setFocus] = useState<"subject" | "body">("body");

  const dirty = JSON.stringify(normalize(steps)) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty && !readOnly);

  const stepIdx = Math.min(sel.step, steps.length - 1);
  const step = steps[stepIdx]!;
  const variantIdx = Math.min(sel.variant, step.variants.length - 1);
  const variant = step.variants[variantIdx]!;

  const update = (fn: (draft: SequenceStep[]) => void) =>
    setSteps((cur) => {
      const draft = structuredClone(cur);
      fn(draft);
      return draft;
    });
  const setVariant = (patch: Partial<SequenceVariant>) => update((d) => Object.assign(d[stepIdx]!.variants[variantIdx]!, patch));

  const isTask = isTaskStep(step);
  const kind: TaskStepKind = step.task ?? "todo";

  const insert = (text: string) => {
    // The subject (or a task's title), a task's note, or else the email editor.
    const field = focus === "subject" ? subjectRef.current : isTask ? noteRef.current : null;
    if (field) {
      const key = focus === "subject" ? "subject" : "body";
      const current = variant[key];
      const start = field.selectionStart ?? current.length;
      const end = field.selectionEnd ?? start;
      setVariant({ [key]: current.slice(0, start) + text + current.slice(end) });
      requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(start + text.length, start + text.length);
      });
    } else editor.current?.insertText(text);
  };

  const addStep = async (task?: TaskStepKind) => {
    if (launched && !(await confirm({ title: "Add a step to a live campaign?", description: "Leads that already finished the sequence won't get the new step. Leads still in progress will.", confirmLabel: "Add step" }))) return;
    update((d) => {
      d.push(task ? { type: "task", task, delay: 1, delay_unit: "days", variants: [blankVariant()] } : { type: "email", delay: 2, delay_unit: "days", variants: [blankVariant()] });
    });
    setSel({ step: steps.length, variant: 0 });
    setFocus(task ? "subject" : "body");
  };

  const removeStep = async (i: number) => {
    if (steps.length === 1) return toast.error("A sequence needs at least one step");
    const target = steps[i]!;
    const task = isTaskStep(target);
    const what = task ? "The task step is removed." : target.variants.length > 1 ? `The step and its ${target.variants.length} variants are removed.` : "The step is removed.";
    const ok = await confirm({
      title: `Delete step ${i + 1}?`,
      description: launched
        ? `This campaign is live. Deleting a step can make past step analytics harder to read.${task ? " Leads waiting for this task go on to the next step." : ""} After you save, you can bring it back from Versions.`
        : what,
      confirmLabel: "Delete step",
      danger: true,
    });
    if (!ok) return;
    update((d) => {
      d.splice(i, 1);
    });
    // Stay on the step that was open; it moves up one when a step before it goes.
    setSel((cur) => (cur.step === i ? { step: Math.max(0, i - 1), variant: 0 } : cur.step > i ? { ...cur, step: cur.step - 1 } : cur));
  };

  const addVariant = () => {
    update((d) => {
      const s = d[stepIdx]!;
      s.variants.push({ subject: s.variants[0]?.subject ?? "", body: "" });
    });
    setSel({ step: stepIdx, variant: step.variants.length });
  };

  const duplicateVariant = () => {
    update((d) => {
      d[stepIdx]!.variants.push({ ...structuredClone(variant), v_disabled: undefined });
    });
    setSel({ step: stepIdx, variant: step.variants.length });
  };

  const removeVariant = async () => {
    if (step.variants.length === 1) return;
    if (!variant.v_disabled && step.variants.filter((v) => !v.v_disabled).length === 1) return toast.error("This is the step's only variant that's on. Turn another one on first.");
    if (!(await confirm({ title: `Delete variant ${letter(variantIdx)}?`, confirmLabel: "Delete variant", danger: true }))) return;
    update((d) => {
      d[stepIdx]!.variants.splice(variantIdx, 1);
    });
    setSel({ step: stepIdx, variant: Math.max(0, variantIdx - 1) });
  };

  const toggleVariant = () => {
    const enabled = step.variants.filter((v) => !v.v_disabled).length;
    if (!variant.v_disabled && enabled <= 1) return toast.error("You must have at least one active variant in a step.");
    setVariant({ v_disabled: variant.v_disabled ? undefined : true });
  };

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!subsequence && isTaskStep(steps[0])) out.push("A campaign starts with an email. Put task steps after it.");
    steps.forEach((s, i) => {
      const task = isTaskStep(s) ? taskStepProblem(s, i + 1) : null;
      if (task) out.push(task);
      if (!isTaskStep(s) && s.variants.every((v) => v.v_disabled)) out.push(`Step ${i + 1}: turn on at least one variant.`);
      s.variants.forEach((v, j) => {
        const err = validateBraces(`${v.subject}\n${v.body}`);
        if (err) out.push(`Step ${i + 1}${s.variants.length > 1 ? ` variant ${letter(j)}` : ""}: ${err}`);
      });
    });
    return out;
  }, [steps, subsequence]);

  const save = async () => {
    if (problems.length) {
      toast.error(problems[0]!);
      return false;
    }
    setSaving(true);
    const sent = steps;
    sending(sent);
    try {
      await onSave(normalize(sent));
      toast.success("Sequence saved");
      return true;
    } catch (e) {
      sending(undefined);
      toast.error(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };
  useReportUnsaved(dirty && !readOnly, save, onUnsaved);

  const spintax = async () => {
    if (!plain(variant.body)) return toast.error("Write the email first");
    // The variant it's for, as it is now: the answer goes in only if that's still there, unchanged.
    const at = { step: stepIdx, variant: variantIdx };
    const before = { subject: variant.subject, body: variant.body };
    const current = () => stepsNow.current[at.step]?.variants[at.variant];
    const put = (text: { subject: string; body: string }) =>
      update((d) => {
        const v = d[at.step]?.variants[at.variant];
        if (v) Object.assign(v, text);
      });
    setSpinning(true);
    try {
      const r = await post<{ subject: string; body: string }>("/api/app/ai/spintax", before);
      const now = current();
      if (!now || now.subject !== before.subject || now.body !== before.body) return void toast.error("The email changed while the spintax was being written, so it wasn't added. Try again.");
      put({ subject: r.subject || before.subject, body: r.body });
      toast.success("Spintax added", { action: { label: "Undo", onClick: () => (current() ? put(before) : toast.error("That email is gone, so there's nothing to undo.")) } });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSpinning(false);
    }
  };

  // A follow-up without a subject replies in the thread, under the subject of the last email before it that had one.
  const threadSubject =
    steps
      .slice(0, stepIdx)
      .reverse()
      .find((s) => !isTaskStep(s) && s.variants[0]?.subject?.trim())
      ?.variants[0]?.subject.trim() ?? "";
  const replyTo = (subject: string) => (/^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`);
  const subjectPlaceholder = stepIdx === 0 ? (subsequence ? "Leave empty to use the parent campaign's subject" : "Your subject") : "Leave empty to reply in the same thread";

  return (
    <div className="grid gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
      {/* Step list */}
      <div>
        <ol className="space-y-0">
          {steps.map((s, i) => {
            const v0 = s.variants[0]!;
            const active = i === stepIdx;
            const task = isTaskStep(s);
            const next = steps[i + 1];
            const deletable = !readOnly && steps.length > 1;
            return (
              <li key={i}>
                {i === 0 && subsequence && (
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                    Wait
                    <NumberInput
                      value={s.pre_delay ?? 0}
                      onChange={(n) => update((d) => void (d[0]!.pre_delay = n ?? 0))}
                      min={0}
                      max={365}
                      className="w-16"
                      disabled={readOnly}
                      aria-label="Wait before the first step"
                    />
                    <NativeSelect
                      size="sm"
                      className="w-24"
                      value={s.pre_delay_unit ?? "days"}
                      onChange={(u) => update((d) => void (d[0]!.pre_delay_unit = u as "days"))}
                      disabled={readOnly}
                      aria-label="Unit of the wait before the first step"
                      options={[
                        { value: "minutes", label: "minutes" },
                        { value: "hours", label: "hours" },
                        { value: "days", label: "days" },
                      ]}
                    />
                    {task ? "then add the task" : "then send"}
                  </div>
                )}
                <div className={cn("group relative rounded-xl border bg-panel shadow-card transition-colors", active ? "border-brand ring-2 ring-[var(--ring)]" : "border-line hover:border-line-strong")}>
                  <button type="button" onClick={() => setSel({ step: i, variant: 0 })} aria-current={active ? "step" : undefined} className="w-full rounded-xl p-3 text-left">
                    <span className={cn("flex items-center justify-between gap-2", deletable && "pr-6")}>
                      <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
                        {task && <TaskIcon kind={s.task} size={13} className="shrink-0 text-muted" />}
                        Step {i + 1}
                        {task && <span className="truncate font-normal text-muted">· {TASK_STEPS[s.task ?? "todo"].label}</span>}
                      </span>
                      {s.variants.length > 1 && <span className="rounded bg-panel-2 px-1.5 text-[11px] text-muted">{s.variants.length} variants</span>}
                    </span>
                    {task ? (
                      <>
                        <span className="mt-1 block truncate text-xs text-muted">{v0.subject || defaultTaskTitle(s.task ?? "todo")}</span>
                        <span className="mt-0.5 block truncate text-xs text-faint">{v0.body.trim() || `No ${TASK_STEPS[s.task ?? "todo"].note.label.toLowerCase()}`}</span>
                      </>
                    ) : (
                      <>
                        <span className="mt-1 block truncate text-xs text-muted">{v0.subject || (i === 0 ? (subsequence ? "<Parent campaign's subject>" : "<Empty subject>") : "<Previous email's subject>")}</span>
                        <span className="mt-0.5 block truncate text-xs text-faint">{plain(v0.body) || "Empty email"}</span>
                      </>
                    )}
                  </button>
                  {deletable && (
                    <button
                      type="button"
                      aria-label={`Delete step ${i + 1}`}
                      title="Delete step"
                      onClick={() => removeStep(i)}
                      className={cn(
                        "absolute right-1.5 top-2 rounded p-1.5 text-faint transition-opacity hover:bg-panel-2 hover:text-bad focus-visible:pointer-events-auto focus-visible:opacity-100",
                        // Hidden on the other steps until hovered: a tap there opens the step, never this.
                        active ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
                      )}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                {i < steps.length - 1 && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 pl-4 text-xs text-muted">
                    <span className="h-6 w-px bg-line-strong" />
                    <span className="whitespace-nowrap">{task ? "Wait" : isTaskStep(next) ? "Next step in" : "Send next message in"}</span>
                    <NumberInput value={s.delay} onChange={(n) => update((d) => void (d[i]!.delay = n ?? 0))} min={0} max={365} className="w-16" disabled={readOnly} aria-label={`Wait after step ${i + 1}`} />
                    <NativeSelect
                      size="sm"
                      className="w-24"
                      value={s.delay_unit ?? "days"}
                      onChange={(u) => update((d) => void (d[i]!.delay_unit = u as "days"))}
                      disabled={readOnly}
                      aria-label={`Unit of the wait after step ${i + 1}`}
                      options={[
                        { value: "minutes", label: "minutes" },
                        { value: "hours", label: "hours" },
                        { value: "days", label: "days" },
                      ]}
                    />
                    {task && <span className="whitespace-nowrap">after it's done</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {!readOnly && (
          <div className="mt-3 flex gap-2">
            <Button className="flex-1" icon={<Mail size={14} />} onClick={() => addStep()}>
              Add email
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button className="flex-1" icon={<Plus size={14} />}>
                  Add task
                  <ChevronDown size={13} className="text-faint" />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                {TASK_STEP_KINDS.map((k) => (
                  <MenuItem key={k} icon={<TaskIcon kind={k} />} onSelect={() => addStep(k)}>
                    {TASK_STEPS[k].label}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
        )}
        {!readOnly && <p className="mt-2 text-xs text-faint">A task is something you do by hand, like a LinkedIn invitation or a call. The lead waits for it before the next step.</p>}
      </div>

      {/* Editor */}
      <div className="min-w-0">
        {isTask ? (
          <Card padded={false}>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
              <TaskIcon kind={kind} size={15} className="text-muted" />
              <span className="text-[13px] font-medium">Task</span>
              <NativeSelect
                size="sm"
                className="w-56"
                value={kind}
                onChange={(k) => update((d) => void (d[stepIdx]!.task = k as TaskStepKind))}
                disabled={readOnly}
                aria-label="What the task is"
                options={TASK_STEP_KINDS.map((k) => ({ value: k, label: TASK_STEPS[k].label }))}
              />
            </div>
            <div className="space-y-4 p-3">
              <p className="text-[13px] text-muted">
                When a lead gets here, a task shows up on Today and in CRM → Tasks, with the lead's details. The lead waits until you mark it done or skip it, then goes on to the next step.
                {kind.startsWith("linkedin") && " Nothing is done on LinkedIn for you."}
              </p>
              <Field label="Title" optional={kind !== "todo"} hint={kind === "todo" ? undefined : `Left empty: "${TASK_STEPS[kind].title("Pat Doe")}", with the lead's name.`}>
                {(id) => (
                  <Input
                    id={id}
                    ref={subjectRef}
                    value={variant.subject}
                    onFocus={() => setFocus("subject")}
                    onChange={(e) => setVariant({ subject: e.target.value })}
                    placeholder={kind === "todo" ? "What to do, e.g. Send {{firstName}} a sample" : TASK_STEPS[kind].title("{{firstName}} {{lastName}}")}
                    disabled={readOnly}
                  />
                )}
              </Field>
              <Field
                label={TASK_STEPS[kind].note.label}
                optional={!TASK_STEPS[kind].note.required}
                hint={
                  kind === "linkedin_connect"
                    ? `${variant.body.length} of ${LINKEDIN_NOTE_MAX} characters before variables are filled in. LinkedIn takes notes of up to ${LINKEDIN_NOTE_MAX}.`
                    : "Shown with the task, with each lead's details filled in, ready to copy."
                }
                error={kind === "linkedin_connect" && variant.body.length > LINKEDIN_NOTE_MAX ? `Longer than the ${LINKEDIN_NOTE_MAX} characters LinkedIn takes.` : null}
              >
                {(id) => (
                  <Textarea
                    id={id}
                    ref={noteRef}
                    rows={8}
                    value={variant.body}
                    onFocus={() => setFocus("body")}
                    onChange={(e) => setVariant({ body: e.target.value })}
                    placeholder={TASK_STEPS[kind].note.placeholder}
                    disabled={readOnly}
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                {!readOnly && <VariablesMenu onInsert={insert} customVariables={customVariables} size="sm" />}
                {versions && <VersionsButton path={versions.path} onRestored={versions.onRestored} dirty={dirty && !readOnly} readOnly={readOnly} subsequence={subsequence} />}
                {problems.length > 0 && <span className="text-xs text-bad">{problems[0]}</span>}
                {!readOnly && (
                  <Button className="ml-auto" variant="primary" size="sm" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={save}>
                    {dirty ? "Save" : "Saved"}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ) : (
          <Card padded={false}>
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
              {step.variants.map((v, j) => (
                <button
                  key={j}
                  type="button"
                  onClick={() => setSel({ step: stepIdx, variant: j })}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium",
                    j === variantIdx ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-panel-2",
                    v.v_disabled && "line-through opacity-60",
                  )}
                >
                  {letter(j)}
                </button>
              ))}
              {!readOnly && step.variants.length < 26 && (
                <Button size="xs" variant="ghost" icon={<Plus size={13} />} onClick={addVariant}>
                  Add variant
                </Button>
              )}
              {!readOnly && (
                <div className="ml-auto flex items-center gap-0.5">
                  <Tooltip content={variant.v_disabled ? "Enable this variant" : "Disable this variant (it stops being sent)"}>
                    <Button size="icon-sm" variant="ghost" aria-label={variant.v_disabled ? "Enable variant" : "Disable variant"} onClick={toggleVariant}>
                      {variant.v_disabled ? <EyeOff size={14} /> : <Eye size={14} />}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Duplicate variant">
                    <Button size="icon-sm" variant="ghost" aria-label="Duplicate variant" onClick={duplicateVariant}>
                      <Copy size={14} />
                    </Button>
                  </Tooltip>
                  {step.variants.length > 1 && (
                    <Tooltip content="Delete variant">
                      <Button size="icon-sm" variant="ghost" aria-label="Delete variant" onClick={removeVariant}>
                        <Trash2 size={14} />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-3 p-3">
              {variant.v_disabled && <Callout tone="warn">This variant is disabled and won't be sent.</Callout>}
              {textOnly && <p className="text-xs text-muted">This campaign sends plain text: formatting and images are left out. Preview shows the email as it goes out.</p>}
              <div className="flex items-center gap-2">
                <span className="w-14 text-[13px] text-muted">Subject</span>
                <Input
                  ref={subjectRef}
                  value={variant.subject}
                  onFocus={() => setFocus("subject")}
                  onChange={(e) => setVariant({ subject: e.target.value })}
                  placeholder={stepIdx > 0 && threadSubject ? replyTo(threadSubject) : subjectPlaceholder}
                  disabled={readOnly}
                  className="flex-1"
                />
              </div>
              <RichEditor
                ref={editor}
                value={variant.body}
                onChange={(html) => setVariant({ body: html })}
                onFocus={() => setFocus("body")}
                placeholder="Start typing here…"
                minHeight={320}
                disabled={readOnly}
                toolbarExtra={
                  <>
                    <VariablesMenu onInsert={insert} customVariables={customVariables} />
                    <TemplatesPicker
                      onPick={async (t) => {
                        if (await confirmReplace(!!plain(variant.body))) setVariant({ subject: t.subject || variant.subject, body: t.body });
                      }}
                      onSaveCurrent={() => setDialog("save-template")}
                    />
                    <AiToolsMenu onSequence={() => setDialog("ai-sequence")} onWrite={() => setDialog("ai-write")} onSpintax={spintax} onSpam={() => setDialog("spam")} spinning={spinning} />
                  </>
                }
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon={<Eye size={14} />} onClick={() => setDialog("preview")}>
                  Preview & test
                </Button>
                {versions && <VersionsButton path={versions.path} onRestored={versions.onRestored} dirty={dirty && !readOnly} readOnly={readOnly} subsequence={subsequence} />}
                {problems.length > 0 && <span className="text-xs text-bad">{problems[0]}</span>}
                {!readOnly && (
                  <Button className="ml-auto" variant="primary" size="sm" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={save}>
                    {dirty ? "Save" : "Saved"}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}
        <p className="mt-2 text-xs text-faint">
          Variables like <code>{"{{firstName}}"}</code> fill in from each lead. <code>{"{{RANDOM | Hi | Hey}}"}</code> picks one option per {isTask ? "task" : "email"}.
        </p>
      </div>

      <AiSequenceDialog
        open={dialog === "ai-sequence"}
        onOpenChange={(v) => setDialog(v ? "ai-sequence" : null)}
        onApply={async (next) => {
          const has = steps.some((s) => s.variants.some((v) => plain(v.body)));
          if (await confirmReplace(has, "the whole sequence")) {
            setSteps(normalize(next));
            setSel({ step: 0, variant: 0 });
          }
        }}
      />
      <AiWriteDialog open={dialog === "ai-write"} onOpenChange={(v) => setDialog(v ? "ai-write" : null)} subject={variant.subject} body={variant.body} onApply={(r) => setVariant({ subject: r.subject || variant.subject, body: r.body })} />
      <SpamCheckDialog open={dialog === "spam"} onOpenChange={(v) => setDialog(v ? "spam" : null)} subject={variant.subject} body={variant.body} onApply={(r) => setVariant(r)} />
      <PreviewDialog
        open={dialog === "preview"}
        onOpenChange={(v) => setDialog(v ? "preview" : null)}
        campaignId={campaignId}
        subject={variant.subject || (stepIdx > 0 && threadSubject ? replyTo(threadSubject) : "")}
        body={variant.body}
        step={stepIdx}
        subsequence={subsequence}
      />
      <SaveTemplateDialog open={dialog === "save-template"} onOpenChange={(v) => setDialog(v ? "save-template" : null)} subject={variant.subject} body={variant.body} />
    </div>
  );
}
