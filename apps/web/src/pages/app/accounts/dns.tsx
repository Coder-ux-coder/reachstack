import { useState } from "react";
import { toast } from "sonner";
import { CircleCheck, CircleHelp, CircleX, RefreshCw } from "lucide-react";
import type { DomainDns } from "@reachstack/shared";
import { errorMessage, post } from "@/lib/api";
import { ago, plural } from "@/lib/format";
import type { Account } from "@/lib/types";
import { Badge, Button, Tooltip, type Tone } from "@/components/ui";

type RecordKey = "spf" | "dkim" | "dmarc" | "mx";

const RECORDS: Array<{ key: RecordKey; label: string; what: string; fix: (domain: string) => string }> = [
  {
    key: "spf",
    label: "SPF",
    what: "which servers may send for the domain",
    fix: () => "Add the TXT record your email provider gives you for SPF (it starts with v=spf1).",
  },
  {
    key: "dkim",
    label: "DKIM",
    what: "a signature that shows each email really comes from you",
    fix: () => "Turn on DKIM in your email provider's admin console and publish the record it shows. This check looks for the common selectors; a custom one isn't found.",
  },
  {
    key: "dmarc",
    label: "DMARC",
    what: "what inboxes do with mail that fails SPF and DKIM",
    fix: (domain) => `Add a TXT record at _dmarc.${domain} with the value "v=DMARC1; p=none" to start.`,
  },
  {
    key: "mx",
    label: "MX",
    what: "where replies to the domain are delivered",
    fix: () => "Without it, replies bounce. Your email provider lists the MX records to add.",
  },
];

/** What a check comes to: records missing, records that couldn't be looked up, and how worried to be. */
export function dnsSummary(d: DomainDns): { tone: Tone; label: string; missing: string[] } {
  const missing = RECORDS.filter((r) => d[r.key] === false).map((r) => r.label);
  const unknown = RECORDS.filter((r) => d[r.key] === null);
  // Inboxes reject or junk mail without SPF and DKIM; a missing DMARC policy is a warning.
  const tone: Tone = missing.some((m) => m !== "DMARC") ? "bad" : missing.length ? "warn" : unknown.length ? "neutral" : "ok";
  const label = missing.length ? `No ${missing.join(", ")}` : unknown.length ? "Couldn't check" : "All set";
  return { tone, label, missing };
}

const stateWord = (v: boolean | null) => (v ? "found" : v === null ? "couldn't be looked up" : "missing");

/** The DNS column of the account list. */
export function DnsBadge({ account }: { account: Account }) {
  if (account.connection === "sandbox") return <span className="text-xs text-faint">Sandbox</span>;
  const d = account.dns;
  if (!d) return <span className="text-xs text-faint">Not checked</span>;
  const s = dnsSummary(d);
  return (
    <Tooltip content={`${RECORDS.map((r) => `${r.label} ${stateWord(d[r.key])}`).join(", ")}. Checked ${ago(d.checked_at)}.`}>
      <span>
        <Badge tone={s.tone}>{s.label}</Badge>
      </span>
    </Tooltip>
  );
}

/** Runs the check for these accounts (or the whole selection) and says how it went. */
export async function runDnsCheck(target: Record<string, unknown>) {
  const r = await post<{ items: DomainDns[]; sandbox: number }>("/api/app/accounts/dns-check", target);
  const bad = r.items.filter((d) => dnsSummary(d).missing.length).length;
  if (!r.items.length) toast.info(r.sandbox ? "Sandbox mailboxes have no DNS to check." : "No domains to check.");
  else if (bad) toast.warning(`${plural(bad, "domain")} of ${r.items.length} ${bad === 1 ? "is" : "are"} missing records. Open an account to see what to add.`);
  else toast.success(`Checked ${plural(r.items.length, "domain")}: all set.`);
  return r;
}

function StateIcon({ value }: { value: boolean | null }) {
  if (value === null) return <CircleHelp size={16} className="mt-px shrink-0 text-faint" aria-label="Unknown" />;
  return value ? <CircleCheck size={16} className="mt-px shrink-0 text-ok" aria-label="Found" /> : <CircleX size={16} className="mt-px shrink-0 text-bad" aria-label="Missing" />;
}

/** "Domain setup" in the account panel: each record, what it's for and what to add when it's missing. */
export function DomainSetup({ account, onChecked }: { account: Account; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  if (account.connection === "sandbox") return null;
  const domain = account.email.slice(account.email.lastIndexOf("@") + 1);
  const d = account.dns;
  const check = async () => {
    setBusy(true);
    try {
      await runDnsCheck({ emails: [account.email] });
      onChecked();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const detail = (key: RecordKey) => {
    if (!d?.[key]) return null;
    if (key === "spf") return d.details.spf;
    if (key === "dmarc") return d.details.dmarc;
    if (key === "dkim") return d.details.dkim_selector ? `Selector: ${d.details.dkim_selector}` : null;
    return d.details.mx.slice(0, 3).join(", ");
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium">Domain setup · {domain}</p>
        <Button size="xs" icon={<RefreshCw size={13} />} loading={busy} onClick={check}>
          {d ? "Check again" : "Check now"}
        </Button>
      </div>
      {!d ? (
        <p className="text-[13px] text-muted">Not checked yet. The check looks up the domain's SPF, DKIM, DMARC and MX records.</p>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {RECORDS.map((r) => {
              const v = d[r.key];
              const extra = detail(r.key);
              return (
                <li key={r.key} className="flex gap-2.5 px-3 py-2.5 text-[13px]">
                  <StateIcon value={v} />
                  <div className="min-w-0">
                    <p>
                      <span className="font-medium">{r.label}</span> <span className="text-muted">{stateWord(v)}: {r.what}.</span>
                    </p>
                    {v === false && <p className="mt-0.5 text-xs text-muted">{d.details.notes?.[r.key] ?? r.fix(domain)}</p>}
                    {extra && <p className="mt-0.5 break-all font-mono text-[11.5px] text-muted">{extra}</p>}
                    {v && r.key === "dmarc" && d.details.dmarc_domain && (
                      <p className="mt-0.5 text-xs text-muted">Set at {d.details.dmarc_domain}, which covers its subdomains.</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-xs text-muted">Checked {ago(d.checked_at)}, and again every day.</p>
        </>
      )}
    </div>
  );
}
