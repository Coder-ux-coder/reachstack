// Ideal customer profile editing, shared by the AI Sales Agent memory and Copilot memory.
import { useEffect, useState } from "react";
import { EMPLOYEE_BANDS, INDUSTRY_TREE } from "@reachstack/shared";
import { cn } from "@/lib/cn";
import { Button, Dialog, Field, Input, TagInput, Textarea } from "@/components/ui";

export interface Icp {
  /** Set by the server; kept as is so campaigns stay linked to their profile. */
  id?: string;
  name: string;
  location?: string[];
  business_offer?: string;
  problems_solved?: string[];
  benefits?: string[];
  usp?: string;
  customer_goals?: string[];
  success_stories?: string;
  keywords?: { include?: string | null; exclude?: string | null };
  company_size?: string[];
  industry?: string[];
  job_title?: { include?: string[]; exclude?: string[] };
}

const INDUSTRIES = Object.keys(INDUSTRY_TREE);
const BANDS = Object.keys(EMPLOYEE_BANDS);

export function ChipToggle({ options, value, onChange, disabled }: { options: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o) : [...value, o])}
            className={cn("rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60", on ? "border-brand bg-brand-soft text-brand-text" : "border-line text-muted hover:text-text")}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

export function IcpDialog({
  value,
  onClose,
  onSave,
  description = "The agent writes a campaign for each active profile and looks for people who match it.",
  targeting = false,
}: {
  value: { icp: Icp; index: number | null } | null;
  onClose: () => void;
  onSave: (icp: Icp, index: number | null) => void;
  description?: string;
  /** Also edit locations and a profile-specific offer (Copilot memory). */
  targeting?: boolean;
}) {
  const [icp, setIcp] = useState<Icp>({ name: "" });
  useEffect(() => {
    if (value) setIcp(value.icp);
  }, [value]);
  const set = (p: Partial<Icp>) => setIcp((x) => ({ ...x, ...p }));
  return (
    <Dialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={value?.index === null ? "New customer profile" : "Edit customer profile"}
      description={description}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!icp.name.trim()}
            onClick={() => {
              onSave({ ...icp, name: icp.name.trim() }, value?.index ?? null);
              onClose();
            }}
          >
            Done
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={icp.name} onChange={(e) => set({ name: e.target.value })} placeholder="Heads of growth at Series A SaaS" maxLength={200} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Job titles to target">{(id) => <TagInput id={id} value={icp.job_title?.include ?? []} onChange={(v) => set({ job_title: { ...icp.job_title, include: v } })} placeholder="Type and press Enter" />}</Field>
          <Field label="Job titles to skip" optional>
            {(id) => <TagInput id={id} value={icp.job_title?.exclude ?? []} onChange={(v) => set({ job_title: { ...icp.job_title, exclude: v } })} placeholder="Intern, Assistant" />}
          </Field>
        </div>
        {targeting && (
          <Field label="Locations" optional hint="Countries, regions or cities. Leave empty for anywhere.">
            {(id) => <TagInput id={id} value={icp.location ?? []} onChange={(v) => set({ location: v })} placeholder="United States, Germany" />}
          </Field>
        )}
        <Field label="Industries" hint="Leave empty for any industry.">
          {() => <ChipToggle options={INDUSTRIES} value={icp.industry ?? []} onChange={(v) => set({ industry: v })} />}
        </Field>
        <Field label="Company size (employees)" hint="Leave empty for any size.">
          {() => <ChipToggle options={BANDS} value={icp.company_size ?? []} onChange={(v) => set({ company_size: v })} />}
        </Field>
        <Field label="Problems you solve for them">{(id) => <TagInput id={id} value={icp.problems_solved ?? []} onChange={(v) => set({ problems_solved: v })} placeholder="One per entry" />}</Field>
        <Field label="Benefits they get" optional>
          {(id) => <TagInput id={id} value={icp.benefits ?? []} onChange={(v) => set({ benefits: v })} placeholder="One per entry" />}
        </Field>
        <Field label="Their goals" optional>
          {(id) => <TagInput id={id} value={icp.customer_goals ?? []} onChange={(v) => set({ customer_goals: v })} placeholder="One per entry" />}
        </Field>
        {targeting && (
          <Field label="Offer for this profile" optional>
            {(id) => <Textarea id={id} rows={2} value={icp.business_offer ?? ""} onChange={(e) => set({ business_offer: e.target.value })} placeholder="A free audit for their onboarding flow" maxLength={5_000} />}
          </Field>
        )}
        <Field label="Why you and not someone else" optional>
          {(id) => <Textarea id={id} rows={2} value={icp.usp ?? ""} onChange={(e) => set({ usp: e.target.value })} maxLength={5_000} />}
        </Field>
        <Field label="Results you've had with similar customers" optional hint="Only real ones: the agent quotes these in emails.">
          {(id) => <Textarea id={id} rows={2} value={icp.success_stories ?? ""} onChange={(e) => set({ success_stories: e.target.value })} maxLength={10_000} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company keywords" optional>
            {(id) => <Input id={id} value={icp.keywords?.include ?? ""} onChange={(e) => set({ keywords: { ...icp.keywords, include: e.target.value } })} placeholder="ecommerce, shopify" />}
          </Field>
          <Field label="Keywords to skip" optional>
            {(id) => <Input id={id} value={icp.keywords?.exclude ?? ""} onChange={(e) => set({ keywords: { ...icp.keywords, exclude: e.target.value } })} placeholder="agency" />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
