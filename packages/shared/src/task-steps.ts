// Task steps: what a sequence asks you to do by hand (look at a LinkedIn profile, send an invitation or a message,
// call, anything else). A lead that reaches one waits until its task is marked done or skipped; nothing is automated
// on LinkedIn. The step's one variant holds the task's title (subject, optional) and its note (body, plain text), both
// with lead variables.
import type { SequenceStep } from "./types";

export const TASK_STEP_KINDS = ["linkedin_visit", "linkedin_connect", "linkedin_message", "call", "todo"] as const;
export type TaskStepKind = (typeof TASK_STEP_KINDS)[number];

export interface TaskStepInfo {
  label: string;
  /** The kind of CRM task it creates. */
  crmType: "linkedin" | "call" | "todo";
  /** The task's title when the step doesn't give one, for a lead called `name`. */
  title: (name: string) => string;
  note: { label: string; placeholder: string; required?: boolean };
}

export const TASK_STEPS: Record<TaskStepKind, TaskStepInfo> = {
  linkedin_visit: {
    label: "LinkedIn: view profile",
    crmType: "linkedin",
    title: (name) => `View ${name}'s LinkedIn profile`,
    note: { label: "Notes", placeholder: "What to look for (optional)" },
  },
  linkedin_connect: {
    label: "LinkedIn: invitation",
    crmType: "linkedin",
    title: (name) => `Connect with ${name} on LinkedIn`,
    note: { label: "Invitation note", placeholder: "Hi {{firstName}}, … (optional)" },
  },
  linkedin_message: {
    label: "LinkedIn: message",
    crmType: "linkedin",
    title: (name) => `Message ${name} on LinkedIn`,
    note: { label: "Message", placeholder: "Hi {{firstName}}, …", required: true },
  },
  call: {
    label: "Call",
    crmType: "call",
    title: (name) => `Call ${name}`,
    note: { label: "Talking points", placeholder: "What to say (optional)" },
  },
  todo: {
    label: "Other task",
    crmType: "todo",
    title: (name) => `Task for ${name}`,
    note: { label: "Instructions", placeholder: "What to do (optional)" },
  },
};

/** LinkedIn takes invitation notes of up to this many characters. */
export const LINKEDIN_NOTE_MAX = 300;

export const isTaskStep = (step: Pick<SequenceStep, "type"> | null | undefined): boolean => step?.type === "task";

/** What's missing from a task step before leads can reach it (step numbers from 1), or null. */
export function taskStepProblem(step: SequenceStep, number: number): string | null {
  const v = step.variants[0];
  if (!step.task) return `Step ${number} is a task without a kind.`;
  if (step.task === "todo" && !v?.subject?.trim()) return `Step ${number} is a task without a title. Say what to do.`;
  if (TASK_STEPS[step.task].note.required && !v?.body?.trim()) return `Step ${number} needs the message to send on LinkedIn.`;
  return null;
}
