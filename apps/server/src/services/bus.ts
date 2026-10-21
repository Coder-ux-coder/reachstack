// In-process event bus. Modules (webhooks, automations, AI agents, subsequences, notifications)
// subscribe to domain events emitted by the engine and the API.

export type BusEventType =
  | "email_sent"
  | "email_opened"
  | "email_link_clicked"
  | "reply_received"
  | "auto_reply_received"
  | "email_bounced"
  | "lead_unsubscribed"
  | "lead_interest_changed"
  | "lead_added"
  | "lead_status_changed"
  | "campaign_completed"
  | "campaign_status_changed"
  | "account_error"
  | "account_added"
  | "crm_task_created"
  | "call_completed"
  | "sms_received"
  | "website_visit"
  | "enrichment_completed";

export interface BusEvent {
  type: BusEventType;
  workspaceId: string;
  at: number;
  data: Record<string, unknown>;
}

type Listener = (e: BusEvent) => Promise<void> | void;

const listeners = new Map<string, Listener[]>();

export function on(type: BusEventType | "*", fn: Listener) {
  const list = listeners.get(type) ?? [];
  list.push(fn);
  listeners.set(type, list);
}

/** Fire-and-forget: listeners run asynchronously; failures are logged, never thrown to the emitter. */
export function emit(type: BusEventType, workspaceId: string, data: Record<string, unknown>) {
  const event: BusEvent = { type, workspaceId, at: Date.now(), data };
  const targets = [...(listeners.get(type) ?? []), ...(listeners.get("*") ?? [])];
  for (const fn of targets) {
    Promise.resolve()
      .then(() => fn(event))
      .catch((err) => console.error(`[bus:${type}]`, err));
  }
}
