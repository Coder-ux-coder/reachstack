// /app/crm/calls-and-sms — calling and texting setup: the Twilio connection, your own phone (rung first on
// outgoing calls, and where incoming calls are forwarded), the workspace's numbers and the webhook addresses.
import { useQueryClient } from "@tanstack/react-query";
import { Download, Phone, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { del, errorMessage, get, patch, post } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks";
import { useCan, useSession } from "@/lib/session";
import { Badge, Button, Callout, CopyButton, Dialog, EmptyState, Field, Input, KeyValue, NativeSelect, Section, SkeletonRows, useConfirm } from "@/components/ui";
import { usePhoneSettings, useMembers, type PhoneNumber } from "@/pages/app/crm/shared";
import { SettingsHeader } from "./parts";

interface Available {
  number: string;
  friendly_name: string;
  locality: string | null;
  region: string | null;
  voice: boolean;
  sms: boolean;
}

const COUNTRIES = [
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "GB", label: "United Kingdom" },
  { value: "AU", label: "Australia" },
  { value: "DE", label: "Germany" },
  { value: "FR", label: "France" },
  { value: "NL", label: "Netherlands" },
  { value: "IE", label: "Ireland" },
  { value: "SE", label: "Sweden" },
  { value: "ES", label: "Spain" },
];

function BuyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [country, setCountry] = useState("US");
  const [type, setType] = useState("Local");
  const [areaCode, setAreaCode] = useState("");
  const [contains, setContains] = useState("");
  const [results, setResults] = useState<Available[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);

  useEffect(() => {
    if (open) setResults(null);
  }, [open]);

  const search = async () => {
    setSearching(true);
    try {
      const r = await get<{ items: Available[] }>("/api/app/crm/phone-numbers/available", { country, type, area_code: areaCode.trim() || undefined, contains: contains.trim() || undefined });
      setResults(r.items);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSearching(false);
    }
  };
  const buy = async (n: Available) => {
    if (!(await confirm({ title: `Buy ${n.friendly_name}?`, description: "Twilio adds this number to your account and bills you for it monthly until you release it.", confirmLabel: "Buy number" }))) return;
    setBuying(n.number);
    try {
      await post("/api/app/crm/phone-numbers", { number: n.number });
      toast.success(`${n.friendly_name} is yours`);
      qc.invalidateQueries({ queryKey: ["crm", "phone-settings"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBuying(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title="Buy a phone number" description="Numbers come from the server's Twilio account.">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Country">{(id) => <NativeSelect id={id} value={country} onChange={setCountry} options={COUNTRIES} />}</Field>
          <Field label="Type">
            {(id) => (
              <NativeSelect
                id={id}
                value={type}
                onChange={setType}
                options={[
                  { value: "Local", label: "Local" },
                  { value: "Mobile", label: "Mobile" },
                  { value: "TollFree", label: "Toll-free" },
                ]}
              />
            )}
          </Field>
          <Field label="Area code" optional>
            {(id) => <Input id={id} inputMode="numeric" value={areaCode} maxLength={5} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ""))} placeholder="415" />}
          </Field>
          <Field label="Contains" optional>
            {(id) => <Input id={id} value={contains} maxLength={10} onChange={(e) => setContains(e.target.value)} placeholder="555" />}
          </Field>
        </div>
        <Button icon={<Search size={14} />} loading={searching} onClick={search}>
          Search numbers
        </Button>
        {results &&
          (results.length ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {results.map((n) => (
                <li key={n.number} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium tabular-nums">{n.friendly_name}</p>
                    <p className="text-xs text-muted">{[n.locality, n.region].filter(Boolean).join(", ") || n.number}</p>
                  </div>
                  <div className="flex gap-1">
                    {n.voice && <Badge>Voice</Badge>}
                    {n.sms && <Badge>SMS</Badge>}
                  </div>
                  <Button size="sm" variant="primary" loading={buying === n.number} disabled={!!buying} onClick={() => buy(n)}>
                    Buy
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No numbers match. Try another area code or leave the filters empty.</p>
          ))}
      </div>
    </Dialog>
  );
}

function NumberRow({ n, admin, members, myId }: { n: PhoneNumber; admin: boolean; members: Array<{ user_id: string; name: string }>; myId: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const assign = async (userId: string) => {
    try {
      await patch(`/api/app/crm/phone-numbers/${n.id}`, { assigned_to: userId || null });
      toast.success(userId ? "Number assigned" : "Number unassigned");
      qc.invalidateQueries({ queryKey: ["crm", "phone-settings"] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const remove = async (release: boolean) => {
    const ok = await confirm(
      release
        ? {
            title: `Release ${n.number}?`,
            description: "Twilio takes the number back and stops billing for it. You can't get the same number again. Calls and texts already in the CRM stay.",
            confirmLabel: "Release number",
            danger: true,
            typeToConfirm: n.number,
          }
        : { title: `Remove ${n.number} from this workspace?`, description: "The number stays in the Twilio account, so you can import it again later.", confirmLabel: "Remove", danger: true },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await del<{ cleanup_pending: boolean }>(`/api/v2/crm-actions/phone-numbers/${n.id}${release ? "" : "?keep_in_twilio=true"}`);
      toast.success(release ? (r.cleanup_pending ? "Removed here. Release it in the Twilio console too; Twilio didn't answer." : "Number released") : "Number removed from this workspace");
      qc.invalidateQueries({ queryKey: ["crm", "phone-settings"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Phone size={15} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium tabular-nums">{n.number}</p>
        <p className="truncate text-xs text-muted">{n.friendly_name && n.friendly_name !== n.number ? n.friendly_name : " "}</p>
      </div>
      <div className="flex gap-1">
        {n.capabilities?.voice !== false && <Badge>Voice</Badge>}
        {n.capabilities?.sms !== false && <Badge>SMS</Badge>}
      </div>
      {admin ? (
        <NativeSelect
          size="sm"
          className="w-full sm:w-48"
          aria-label={`Who uses ${n.number}`}
          value={n.assigned_to ?? ""}
          onChange={assign}
          options={[{ value: "", label: "Shared (anyone)" }, ...members.map((m) => ({ value: m.user_id, label: m.user_id === myId ? `${m.name} (me)` : m.name }))]}
        />
      ) : (
        <span className="text-xs text-muted">{n.assigned_to_name ? `Used by ${n.assigned_to_name}` : "Shared"}</span>
      )}
      {admin && (
        <div className="flex">
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => remove(false)}>
            Remove
          </Button>
          {n.twilio_sid && (
            <Button size="icon-sm" variant="ghost" aria-label={`Release ${n.number}`} disabled={busy} onClick={() => remove(true)}>
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export default function CallsAndSms() {
  usePageTitle("Calls & SMS");
  const can = useCan();
  const me = useSession();
  const qc = useQueryClient();
  const settings = usePhoneSettings();
  const members = useMembers();
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const s = settings.data;

  useEffect(() => {
    if (s) setPhone(s.my_phone ?? "");
  }, [s?.my_phone]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePhone = async () => {
    setSaving(true);
    try {
      const r = await patch<{ my_phone: string | null }>("/api/app/crm/phone-settings", { my_phone: phone.trim() || null });
      setPhone(r.my_phone ?? "");
      toast.success(r.my_phone ? "Your phone number is saved" : "Your phone number is removed");
      qc.invalidateQueries({ queryKey: ["crm", "phone-settings"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const importNumbers = async () => {
    setImporting(true);
    try {
      const r = await post<{ added: number; skipped: number }>("/api/app/crm/phone-numbers/import");
      toast.success(r.added ? `Imported ${r.added} number${r.added === 1 ? "" : "s"}` : "No new numbers in the Twilio account");
      qc.invalidateQueries({ queryKey: ["crm", "phone-settings"] });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setImporting(false);
    }
  };

  const myCurrent = s?.my_phone ?? "";
  return (
    <div className="space-y-8">
      <SettingsHeader title="Calls & SMS" description="Call and text leads from the CRM. Calls ring your own phone first, then connect you to the lead from your business number." />
      {settings.isLoading || !s ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          {!s.twilio_configured && (
            <Callout tone="warn" title="Twilio isn't connected">
              Calls and texts go through Twilio. Set <code className="rounded bg-panel-2 px-1">TWILIO_ACCOUNT_SID</code> and <code className="rounded bg-panel-2 px-1">TWILIO_AUTH_TOKEN</code> on the server
              and restart it. Until then you can still log calls by hand.
            </Callout>
          )}

          <Section title="Your phone" description="When you click Call, this phone rings first. Incoming calls to a number assigned to you are forwarded here too. Use the international format, such as +14155550123.">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Phone number" className="w-full sm:w-72">
                {(id) => <Input id={id} type="tel" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} placeholder="+14155550123" />}
              </Field>
              <Button variant="primary" loading={saving} disabled={phone.trim() === myCurrent} onClick={savePhone}>
                Save
              </Button>
            </div>
          </Section>

          <Section
            title="Phone numbers"
            description="Business numbers the team calls and texts from. Assign one to a person, or leave it shared."
            actions={
              can.admin &&
              s.twilio_configured && (
                <>
                  <Button size="sm" icon={<Download size={14} />} loading={importing} onClick={importNumbers}>
                    Import from Twilio
                  </Button>
                  <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setBuyOpen(true)}>
                    Buy a number
                  </Button>
                </>
              )
            }
          >
            {s.numbers.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
                {s.numbers.map((n) => (
                  <NumberRow key={n.id} n={n} admin={can.admin} members={members} myId={me.user.id} />
                ))}
              </ul>
            ) : (
              <div className="rounded-xl border border-dashed border-line">
                <EmptyState
                  icon={<Phone size={22} />}
                  title="No phone numbers yet"
                  description={s.twilio_configured ? (can.admin ? "Buy a number, or import the ones already in your Twilio account." : "Ask an admin to add a number.") : "Connect Twilio on the server to add numbers."}
                />
              </div>
            )}
          </Section>

          <Section title="Incoming texts and calls" description="Numbers bought here are pointed at these addresses. For numbers you imported, paste them into each number's settings in the Twilio console.">
            {!s.webhooks.reachable && (
              <Callout tone="warn" className="mb-3">
                Twilio can't reach this server yet: APP_URL has to be a public https address. Outgoing calls and texts work; incoming ones won't arrive until it is.
              </Callout>
            )}
            <KeyValue
              items={[
                ["A message comes in", <WebhookValue key="sms" url={s.webhooks.sms} />],
                ["A call comes in", <WebhookValue key="voice" url={s.webhooks.voice} />],
                ["Call status changes", <WebhookValue key="status" url={s.webhooks.status} />],
              ]}
            />
          </Section>
        </>
      )}
      <BuyDialog open={buyOpen} onOpenChange={setBuyOpen} />
    </div>
  );
}

function WebhookValue({ url }: { url: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate rounded bg-panel-2 px-1.5 py-0.5 text-xs">{url}</code>
      <CopyButton value={url} label="Copy" />
    </span>
  );
}
