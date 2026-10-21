// Task steps (TASK_STEPS in @reachstack/shared): one icon and label per kind, for the sequence editor, step analytics,
// Today and the CRM, and the links that doing one takes.
import { ClipboardCheck, ExternalLink, MessageSquareText, Phone, UserPlus, UserSearch, type LucideIcon } from "lucide-react";
import { TASK_STEPS, type TaskStepKind } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { buttonClass } from "@/components/ui";

const ICONS: Record<TaskStepKind, LucideIcon> = {
  linkedin_visit: UserSearch,
  linkedin_connect: UserPlus,
  linkedin_message: MessageSquareText,
  call: Phone,
  todo: ClipboardCheck,
};

const known = (kind: string | null | undefined): kind is TaskStepKind => !!kind && kind in TASK_STEPS;

export const taskLabel = (kind: string | null | undefined) => (known(kind) ? TASK_STEPS[kind].label : "Task");

/** What a task step's title says when it's left empty, in the editor's words. */
export const defaultTaskTitle = (kind: string | null | undefined) => (known(kind) && kind !== "todo" ? TASK_STEPS[kind].title("the lead") : "No title yet");

export function TaskIcon({ kind, size = 14, className }: { kind: string | null | undefined; size?: number; className?: string }) {
  const Icon = known(kind) ? ICONS[kind] : ClipboardCheck;
  return <Icon size={size} className={className} aria-hidden />;
}

/** The lead a task is for, as far as doing it goes. */
export interface TaskLead {
  name: string | null;
  email: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  phone: string | null;
  location: string | null;
  timezone: string | null;
}

/** "3:42 PM" on the lead's clock, or null for a timezone the browser doesn't know. */
function theirTime(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date());
  } catch {
    return null;
  }
}

/** A web address people can open: LinkedIn profiles are often saved without https://. */
const webAddress = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, "")}`);

const linkClass = buttonClass("secondary", "sm");

/**
 * What doing a task takes: the lead's LinkedIn profile (or a search for them), their phone number, and the time where
 * they are. `kind` is the task step's kind ("call" for any call). Nothing when there's nothing to show.
 */
export function TaskLinks({ kind, lead, onAddPhone, className }: { kind: string | null; lead: TaskLead | null; onAddPhone?: () => void; className?: string }) {
  const linkedin = !!kind?.startsWith("linkedin");
  const call = kind === "call";
  const time = lead?.timezone ? theirTime(lead.timezone) : null;
  if (!lead || (!linkedin && !call && !time)) return null;
  const search = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent([lead.name, lead.company_name].filter(Boolean).join(" ") || lead.email || "")}`;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {linkedin &&
        (lead.linkedin_url ? (
          <a href={webAddress(lead.linkedin_url)} target="_blank" rel="noreferrer noopener" className={linkClass}>
            Open LinkedIn profile
            <ExternalLink size={13} className="text-faint" />
          </a>
        ) : (
          <a href={search} target="_blank" rel="noreferrer noopener" className={linkClass} title="This lead has no LinkedIn address: search LinkedIn for their name">
            Find on LinkedIn
            <ExternalLink size={13} className="text-faint" />
          </a>
        ))}
      {call &&
        (lead.phone ? (
          <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className={linkClass}>
            <Phone size={13} />
            {lead.phone}
          </a>
        ) : (
          <span className="text-xs text-muted">
            No phone number.{" "}
            {onAddPhone && (
              <button type="button" className="text-brand-text hover:underline" onClick={onAddPhone}>
                Add one
              </button>
            )}
          </span>
        ))}
      {time && (
        <span className="text-xs text-faint">
          {time} there{lead.location ? ` (${lead.location})` : ""}
        </span>
      )}
    </div>
  );
}
