import { useEffect, useState } from "react";
import { Link } from "react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, Building2, ExternalLink, GitBranch, Link2, Linkedin, Mail, Pause, Phone, Play, Send, UserPlus, UserRound } from "lucide-react";
import { LeadStatus } from "@reachstack/shared";
import { del, errorMessage, get, post } from "@/lib/api";
import { ago, dateTime, fullName } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useLeadStatuses } from "@/lib/statuses";
import { useCampaignNames, useListNames } from "@/lib/pickers";
import { LeadSheet } from "@/components/leads/LeadSheet";
import { LeadStatusBadge } from "@/components/status";
import { Avatar, Badge, Button, Callout, Card, Dialog, Field, Input, KeyValue, SearchInput, Segmented, Select, Skeleton, Textarea, useConfirm } from "@/components/ui";
import { isReceived, useRefreshUnibox, useUniboxParams, type ThreadDetail } from "./shared";

interface Note {
  id: string;
  body: string;
  created_by_name: string | null;
  timestamp_created: string;
}

function Notes({ email, leadId }: { email: string; leadId: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const key = ["lead-notes", email];
  const notes = useQuery({ queryKey: key, queryFn: () => get<{ items: Note[] }>("/api/app/lead-notes", { lead_email: email }) });
  const add = async () => {
    setBusy(true);
    try {
      await post("/api/app/lead-notes", { lead_email: email, lead_id: leadId, body: text });
      setText("");
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {can.perm("leads") && can.write && (
        <>
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note for your team…" aria-label="New note" />
          {text.trim() && (
            <div className="flex justify-end">
              <Button size="xs" variant="primary" loading={busy} onClick={add}>
                Add note
              </Button>
            </div>
          )}
        </>
      )}
      {notes.data?.items.map((n) => (
        <div key={n.id} className="rounded-lg bg-panel-2 px-3 py-2">
          <p className="whitespace-pre-wrap text-[13px]">{n.body}</p>
          <div className="mt-1 flex items-center justify-between text-[11px] text-faint">
            <span>
              {n.created_by_name ?? "Someone"} · {ago(n.timestamp_created)}
            </span>
            {can.write && (
              <button
                type="button"
                className="hover:text-bad"
                onClick={async () => {
                  if (!(await confirm({ title: "Delete this note?", confirmLabel: "Delete note", danger: true }))) return;
                  await del(`/api/app/lead-notes/${n.id}`).catch((e) => toast.error(errorMessage(e)));
                  qc.invalidateQueries({ queryKey: key });
                }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      ))}
      {notes.data && !notes.data.items.length && !can.write && <p className="text-xs text-muted">No notes yet.</p>}
    </div>
  );
}

/**
 * "Block" dialog: add the address or its whole domain to the workspace blocklist. Blocking only stops future emails: the
 * lead, its conversation and its history stay.
 */
function BlockDialog({ open, onOpenChange, email, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; email: string; onDone: () => void }) {
  const domain = email.split("@")[1] ?? "";
  const [what, setWhat] = useState<"email" | "domain">("email");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await post("/api/v2/block-lists-entries", { bl_value: what === "domain" ? domain : email }).catch((e) => {
        // Already blocked is fine; anything else is a real error.
        if (!/already on the block list/i.test(errorMessage(e))) throw e;
      });
      toast.success(`${what === "domain" ? domain : email} is blocked`);
      onOpenChange(false);
      onDone();
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
      title="Block this lead"
      description="Blocked addresses never receive emails from any campaign in this workspace. The lead and this conversation stay."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={run}>
            Block
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="radio" checked={what === "email"} onChange={() => setWhat("email")} /> Block the address <span className="font-medium">{email}</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={what === "domain"} onChange={() => setWhat("domain")} /> Block everyone at <span className="font-medium">{domain}</span>
        </label>
      </div>
    </Dialog>
  );
}

// ---------- Replies without a lead ----------

interface LeadSuggestion {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  campaign_name: string | null;
  reason: "same_address" | "same_thread" | "copied" | "same_subject" | "same_company" | "search";
}

const REASONS: Record<LeadSuggestion["reason"], string> = {
  same_address: "Same address",
  same_thread: "On this conversation",
  copied: "Copied on the reply",
  same_subject: "Replied to your subject",
  same_company: "Same company",
  search: "Matches your search",
};

/** What linking or making a lead returns: the reply now sits in that lead's conversation. */
interface Linked {
  email_id: string;
  thread_id: string | null;
  lead: { id: string; email: string | null };
}

function LinkLeadDialog({ emailId, open, onOpenChange, onLinked }: { emailId: string; open: boolean; onOpenChange: (v: boolean) => void; onLinked: (r: Linked) => void }) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 250);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const found = useQuery({
    queryKey: ["unibox", "lead-suggestions", emailId, term],
    queryFn: () => get<{ items: LeadSuggestion[] }>(`/api/app/replies/${emailId}/lead-suggestions`, term ? { q: term } : undefined),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const link = async (leadId: string) => {
    setBusy(leadId);
    try {
      onLinked(await post<Linked>(`/api/app/replies/${emailId}/attach`, { lead_id: leadId }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const items = found.data?.items ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Link to a lead" description="The reply joins that lead's conversation, and their emails stop as for any reply.">
      <SearchInput className="w-full" value={q} onChange={setQ} placeholder="Search leads by name, email or company" />
      <div className="mt-3 space-y-1.5">
        {found.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !items.length ? (
          <p className="py-6 text-center text-[13px] text-muted">{term ? "No leads match." : "No likely leads. Search by name, email or company."}</p>
        ) : (
          items.map((l) => {
            const name = [l.first_name, l.last_name].filter(Boolean).join(" ");
            return (
              <div key={l.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <Avatar name={name} email={l.email} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{name || l.email}</p>
                  <p className="truncate text-xs text-muted">{[name ? l.email : null, l.company_name, l.campaign_name].filter(Boolean).join(" · ")}</p>
                  {l.reason !== "search" && (
                    <Badge tone="info" className="mt-1 sm:hidden">
                      {REASONS[l.reason]}
                    </Badge>
                  )}
                </div>
                {l.reason !== "search" && (
                  <Badge tone="info" className="shrink-0 max-sm:hidden">
                    {REASONS[l.reason]}
                  </Badge>
                )}
                <Button size="xs" aria-label={`Link to ${name || l.email}`} loading={busy === l.id} disabled={!!busy} onClick={() => link(l.id)}>
                  Link
                </Button>
              </div>
            );
          })
        )}
      </div>
    </Dialog>
  );
}

function MakeLeadDialog({
  emailId,
  sender,
  open,
  onOpenChange,
  onLinked,
}: {
  emailId: string;
  sender: { address: string; name: string };
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onLinked: (r: Linked) => void;
}) {
  const [kind, setKind] = useState<"campaign" | "list">("campaign");
  const [dest, setDest] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const [f = "", ...rest] = sender.name.replace(/["']/g, "").trim().split(/\s+/);
    setFirst(f);
    setLast(rest.join(" "));
    setCompany("");
    setDest("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const campaigns = useCampaignNames(open);
  const lists = useListNames(open);
  const options = ((kind === "campaign" ? campaigns.data?.items : lists.data?.items) ?? []).map((x) => ({ value: x.id, label: x.name }));
  const create = async () => {
    if (!dest) return toast.error(kind === "campaign" ? "Pick a campaign." : "Pick a list.");
    setBusy(true);
    try {
      onLinked(
        await post<Linked>(`/api/app/replies/${emailId}/create-lead`, {
          [kind === "campaign" ? "campaign_id" : "list_id"]: dest,
          first_name: first.trim() || undefined,
          last_name: last.trim() || undefined,
          company_name: company.trim() || undefined,
        }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !busy && onOpenChange(v)}
      title="Make a lead"
      description={`${sender.address} becomes a lead with this reply on their record. They've replied, so no emails go out to them.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={create}>
            Make lead
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Segmented
          value={kind}
          onChange={(v) => {
            setKind(v);
            setDest("");
          }}
          options={[
            { value: "campaign", label: "In a campaign" },
            { value: "list", label: "In a list" },
          ]}
        />
        <Select
          value={dest || null}
          onChange={setDest}
          options={options}
          placeholder={(kind === "campaign" ? campaigns : lists).isLoading ? "Loading…" : kind === "campaign" ? "Choose a campaign" : "Choose a list"}
          aria-label={kind === "campaign" ? "Campaign" : "List"}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name">{(id) => <Input id={id} value={first} onChange={(e) => setFirst(e.target.value)} />}</Field>
          <Field label="Last name">{(id) => <Input id={id} value={last} onChange={(e) => setLast(e.target.value)} />}</Field>
        </div>
        <Field label="Company">{(id) => <Input id={id} value={company} onChange={(e) => setCompany(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

export function LeadPanel({ thread }: { thread: ThreadDetail }) {
  const can = useCan();
  const statuses = useLeadStatuses();
  const refresh = useRefreshUnibox();
  const [sheet, setSheet] = useState(false);
  const [block, setBlock] = useState(false);
  const [linking, setLinking] = useState(false);
  const [making, setMaking] = useState(false);
  const [, setParams] = useUniboxParams();
  const lead = thread.lead;
  const email = lead?.email ?? thread.emails.find((e) => e.lead)?.lead ?? null;
  const canEdit = can.perm("leads") && can.write;

  const setInterest = async (v: string) => {
    if (!email) return;
    const value = v === "" ? null : Number(v);
    try {
      // This lead's status (the workspace's sync setting carries it to the person's other leads); without one, by address.
      await (lead?.id
        ? post("/api/app/leads/status", { ids: [lead.id], action: "interest", interest_value: value })
        : post("/api/v2/leads/update-interest-status", { lead_email: email, interest_value: value }));
      toast.success("Lead status updated");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const leadAction = async (a: "pause" | "resume") => {
    try {
      await post("/api/app/leads/status", { ids: [lead!.id], action: a });
      toast.success(a === "pause" ? "Lead paused" : "Lead resumed");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const cancelContinuation = async () => {
    try {
      await post(`/api/app/leads/${lead!.id}/cancel-continuation`);
      toast.success("Continuation cancelled");
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (!lead) {
    // The newest reply someone wrote that isn't tied to a lead: it can be linked to one, or its sender made a lead.
    const stray = [...thread.emails].reverse().find((e) => isReceived(e) && !e.lead_id && !(e as { is_bounce?: boolean }).is_bounce);
    const sender = stray ? (stray.from_address_json?.[0] ?? { address: stray.from_address_email ?? "", name: "" }) : null;
    const linked = (r: Linked, what: string) => {
      setLinking(false);
      setMaking(false);
      toast.success(`${what}. Their emails stop, as for any reply.`);
      refresh();
      if (r.thread_id && r.thread_id !== thread.thread_id) setParams({ thread: r.thread_id });
    };
    return (
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Avatar email={email ?? sender?.address} size={40} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{email ?? sender?.address ?? "Unknown sender"}</p>
            <p className="text-xs text-muted">Not linked to a lead</p>
          </div>
        </div>
        {stray && can.perm("unibox") && can.write && (
          <Callout tone="info" title="Is this one of your leads?">
            A reply from another address, a forward or a colleague doesn't stop anyone's emails until it's linked.
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="xs" icon={<Link2 size={12} />} onClick={() => setLinking(true)}>
                Link to a lead
              </Button>
              {canEdit && sender?.address && (
                <Button size="xs" variant="ghost" icon={<UserPlus size={12} />} onClick={() => setMaking(true)}>
                  Make a lead
                </Button>
              )}
            </div>
          </Callout>
        )}
        {stray && <LinkLeadDialog emailId={stray.id} open={linking} onOpenChange={setLinking} onLinked={(r) => linked(r, `Linked to ${r.lead.email ?? "the lead"}`)} />}
        {stray && sender?.address && <MakeLeadDialog emailId={stray.id} sender={sender} open={making} onOpenChange={setMaking} onLinked={(r) => linked(r, `${r.lead.email ?? "The sender"} is now a lead`)} />}
        {email && can.perm("blocklist") && can.write && (
          <Button size="sm" variant="ghost" icon={<Ban size={13} />} onClick={() => setBlock(true)}>
            Block sender
          </Button>
        )}
        {email && <BlockDialog open={block} onOpenChange={setBlock} email={email} onDone={refresh} />}
      </div>
    );
  }

  const name = fullName(lead);
  const custom = Object.entries(lead.payload ?? {}).filter(([, v]) => v !== null && v !== "");
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <Avatar name={name} email={lead.email} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{name || lead.email}</p>
          {name && <p className="truncate text-xs text-muted">{lead.email}</p>}
          {(lead.job_title || lead.company_name) && <p className="mt-0.5 truncate text-xs text-muted">{[lead.job_title, lead.company_name].filter(Boolean).join(" at ")}</p>}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted">Lead status</p>
        <Select
          size="sm"
          disabled={!canEdit}
          value={lead.lt_interest_status === null || lead.lt_interest_status === undefined ? "" : String(lead.lt_interest_status)}
          onChange={setInterest}
          options={[{ value: "", label: "Lead (no status)" }, ...statuses.all.map((s) => ({ value: String(s.code), label: s.label }))]}
          aria-label="Lead status"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <LeadStatusBadge status={lead.status} />
        {canEdit && lead.status === LeadStatus.ACTIVE && (
          <Button size="xs" variant="ghost" icon={<Pause size={12} />} onClick={() => leadAction("pause")}>
            Pause sequence
          </Button>
        )}
        {canEdit && lead.status === LeadStatus.PAUSED && (
          <Button size="xs" variant="ghost" icon={<Play size={12} />} onClick={() => leadAction("resume")}>
            Resume sequence
          </Button>
        )}
      </div>

      {thread.continuation && (
        <Callout tone="info" title="Subsequence continues">
          Step {thread.continuation.step} of “{thread.continuation.name ?? "subsequence"}” goes out {thread.continuation.scheduled_for ? dateTime(thread.continuation.scheduled_for) : "soon"} if there's no reply.
          {canEdit && (
            <button type="button" className="mt-1 block text-xs font-medium text-brand-text hover:underline" onClick={cancelContinuation}>
              Cancel continuation
            </button>
          )}
        </Callout>
      )}

      <Card className="space-y-2 p-3 text-[13px]">
        {thread.campaign && (
          <p className="flex items-center gap-2">
            <Send size={13} className="shrink-0 text-faint" />
            <Link to={`/app/campaign/${thread.campaign.id}/leads?lead=${lead.id}`} className="truncate text-brand-text hover:underline">
              {thread.campaign.name ?? "Campaign"}
            </Link>
          </p>
        )}
        {lead.subsequence_id && (
          <p className="flex items-center gap-2 text-muted">
            <GitBranch size={13} className="shrink-0 text-faint" />
            In a subsequence
          </p>
        )}
        <p className="flex items-center gap-2">
          <Mail size={13} className="shrink-0 text-faint" />
          <span className="truncate">{lead.email}</span>
        </p>
        {lead.phone && (
          <p className="flex items-center gap-2">
            <Phone size={13} className="shrink-0 text-faint" />
            {lead.phone}
          </p>
        )}
        {lead.website && (
          <p className="flex items-center gap-2">
            <Building2 size={13} className="shrink-0 text-faint" />
            <a href={/^https?:\/\//.test(lead.website) ? lead.website : `https://${lead.website}`} target="_blank" rel="noreferrer noopener" className="truncate text-brand-text hover:underline">
              {lead.website}
            </a>
          </p>
        )}
        {lead.linkedin_url && (
          <p className="flex items-center gap-2">
            <Linkedin size={13} className="shrink-0 text-faint" />
            <a href={lead.linkedin_url} target="_blank" rel="noreferrer noopener" className="truncate text-brand-text hover:underline">
              LinkedIn profile
            </a>
          </p>
        )}
      </Card>

      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ["Opens", lead.email_open_count],
          ["Clicks", lead.email_click_count],
          ["Replies", lead.email_reply_count],
        ].map(([k, v]) => (
          <div key={k as string} className="rounded-lg bg-panel-2 px-2 py-1.5">
            <p className="text-[11px] text-muted">{k}</p>
            <p className="text-sm font-semibold tabular-nums">{v ?? 0}</p>
          </div>
        ))}
      </div>

      {(lead.personalization || custom.length > 0) && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Details</p>
          <KeyValue
            items={[
              ...(lead.personalization ? ([["Personalization", lead.personalization]] as Array<[string, string]>) : []),
              ...custom.map(([k, v]) => [k, String(v)] as [string, string]),
            ]}
          />
        </div>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Notes</p>
        {lead.email && <Notes email={lead.email} leadId={lead.id} />}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button size="sm" icon={<UserRound size={13} />} onClick={() => setSheet(true)}>
          Full profile
        </Button>
        {thread.campaign && (
          <Link to={`/app/campaign/${thread.campaign.id}/analytics`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
            Campaign analytics <ExternalLink size={11} />
          </Link>
        )}
        {can.perm("blocklist") && can.write && lead.email && (
          <Button size="sm" variant="ghost" className="ml-auto text-bad" icon={<Ban size={13} />} onClick={() => setBlock(true)}>
            Block
          </Button>
        )}
      </div>
      <LeadSheet leadId={sheet ? lead.id : null} onClose={() => setSheet(false)} onChanged={refresh} />
      {lead.email && <BlockDialog open={block} onOpenChange={setBlock} email={lead.email} onDone={refresh} />}
    </div>
  );
}
