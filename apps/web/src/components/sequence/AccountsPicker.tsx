import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, MailPlus, Search, X } from "lucide-react";
import { AccountStatus } from "@reachstack/shared";
import { get, type Page } from "@/lib/api";
import type { Account } from "@/lib/types";
import { useTags } from "@/components/TagPicker";
import { Badge, Button, Checkbox, Input, Popover } from "@/components/ui";

/** Picks sending accounts by address and/or by tag (accounts carrying any chosen tag are included too). */
export function AccountsPicker({
  emails,
  tagIds,
  onChange,
  disabled,
}: {
  emails: string[];
  tagIds: string[];
  onChange: (v: { emails: string[]; tagIds: string[] }) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const accounts = useQuery({
    queryKey: ["accounts", "picker"],
    queryFn: () => get<Page<Account>>("/api/v2/accounts", { limit: 1000, include_tags: true }),
    select: (d) => d.items,
  });
  const tags = useTags();
  // Until the list has loaded, nothing selected counts as gone or inactive.
  const loaded = accounts.isSuccess;
  const all = accounts.data ?? [];
  const selected = new Set(emails.map((e) => e.toLowerCase()));
  const byTag = useMemo(() => all.filter((a) => a.tags?.some((t) => tagIds.includes(t.id))), [all, tagIds]);
  const effective = new Map<string, Account>();
  for (const a of all) if (selected.has(a.email.toLowerCase())) effective.set(a.email, a);
  for (const a of byTag) effective.set(a.email, a);
  const inactive = loaded ? [...effective.values()].filter((a) => a.status !== AccountStatus.ACTIVE) : [];
  const shown = all.filter((a) => `${a.email} ${a.first_name} ${a.last_name}`.toLowerCase().includes(q.trim().toLowerCase()));
  const missing = loaded ? emails.filter((e) => !all.some((a) => a.email.toLowerCase() === e.toLowerCase())) : [];

  const toggle = (email: string, on: boolean) => onChange({ emails: on ? [...emails, email] : emails.filter((e) => e.toLowerCase() !== email.toLowerCase()), tagIds });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {emails.slice(0, 12).map((e) => (
          <span key={e} className="inline-flex items-center gap-1 rounded-md bg-panel-2 py-0.5 pl-2 pr-1 text-xs">
            {e}
            {!disabled && (
              <button type="button" aria-label={`Remove ${e}`} onClick={() => toggle(e, false)} className="hit-24 rounded p-0.5 text-faint hover:text-text">
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {emails.length > 12 && <span className="text-xs text-muted">+{emails.length - 12} more</span>}
        {tagIds.map((id) => {
          const t = tags.data?.find((x) => x.id === id);
          return (
            <span key={id} className="inline-flex items-center gap-1 rounded-md border border-dashed border-line-strong py-0.5 pl-2 pr-1 text-xs">
              Tag: {t?.label ?? "Unknown"}
              {!disabled && (
                <button type="button" aria-label="Remove tag" onClick={() => onChange({ emails, tagIds: tagIds.filter((x) => x !== id) })} className="hit-24 rounded p-0.5 text-faint hover:text-text">
                  <X size={11} />
                </button>
              )}
            </span>
          );
        })}
        {!emails.length && !tagIds.length && <span className="text-[13px] text-muted">No accounts selected yet.</span>}
      </div>

      {!disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <Popover
            className="w-[22rem] p-0"
            trigger={
              <Button size="sm" icon={<MailPlus size={14} />}>
                Choose accounts
              </Button>
            }
          >
            <div className="border-b border-line p-2">
              <Input inputSize="sm" leading={<Search size={13} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts" autoFocus />
              <div className="mt-2 flex gap-2 text-xs">
                <button type="button" className="text-brand-text hover:underline" onClick={() => onChange({ emails: [...new Set([...emails, ...shown.map((a) => a.email)])], tagIds })}>
                  Select {q ? "matching" : "all"} ({shown.length})
                </button>
                <button type="button" className="text-muted hover:underline" onClick={() => onChange({ emails: [], tagIds })}>
                  Clear
                </button>
              </div>
            </div>
            <div className="scroll-thin max-h-72 overflow-y-auto p-1">
              {shown.map((a) => (
                <label key={a.email} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-panel-2">
                  <Checkbox checked={selected.has(a.email.toLowerCase())} onChange={(v) => toggle(a.email, v)} aria-label={a.email} />
                  <span className="min-w-0 flex-1 truncate">{a.email}</span>
                  {a.status !== AccountStatus.ACTIVE && <Badge tone="warn">Not active</Badge>}
                </label>
              ))}
              {!shown.length && (
                <p className="px-3 py-6 text-center text-xs text-muted">
                  {all.length ? "No matching accounts." : "No accounts connected yet."}{" "}
                  <Link to="/app/account/connect" className="text-brand-text hover:underline">
                    Connect one
                  </Link>
                </p>
              )}
            </div>
            {!!tags.data?.length && (
              <div className="border-t border-line p-2">
                <p className="mb-1 text-xs font-medium text-muted">Or include every account with a tag</p>
                <div className="flex flex-wrap gap-1.5">
                  {tags.data.map((t) => {
                    const on = tagIds.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onChange({ emails, tagIds: on ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id] })}
                        className={`rounded-md border px-2 py-0.5 text-xs ${on ? "border-brand bg-brand-soft text-brand-text" : "border-line text-muted hover:border-line-strong"}`}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Popover>
          <span className="text-xs text-muted">
            {accounts.isError ? (
              <>
                Couldn't load your accounts.{" "}
                <button type="button" className="text-brand-text hover:underline" onClick={() => accounts.refetch()}>
                  Try again
                </button>
              </>
            ) : !loaded ? (
              "Checking your accounts…"
            ) : (
              <>
                {effective.size} account{effective.size === 1 ? "" : "s"} will send
                {byTag.length ? ` (${byTag.length} via tags)` : ""}
              </>
            )}
          </span>
        </div>
      )}

      {inactive.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-warn">
          <AlertTriangle size={13} /> {inactive.length} selected account{inactive.length === 1 ? " isn't" : "s aren't"} active and won't send until fixed.
        </p>
      )}
      {missing.length > 0 && <p className="text-xs text-muted">{missing.length} selected address{missing.length === 1 ? " is" : "es are"} no longer connected and will be skipped.</p>}
    </div>
  );
}
