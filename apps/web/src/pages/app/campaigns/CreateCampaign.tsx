import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Rocket } from "lucide-react";
import { errorMessage, post } from "@/lib/api";
import type { Campaign } from "@/lib/types";
import { usePageTitle } from "@/lib/hooks";
import { Button, Card, Field, Input } from "@/components/ui";

/** The name a campaign gets when the field is left empty. */
const DEFAULT_NAME = "My Campaign";

export default function CreateCampaign() {
  usePageTitle("New campaign");
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Empty to start with (the default shows as the placeholder), so typing a name never adds to the default.
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const final = name.trim() || DEFAULT_NAME;
  const valid = final.length >= 3;

  const create = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const c = await post<Campaign>("/api/app/campaigns", { name: final });
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
      navigate(`/app/campaign/${c.id}/leads`, { replace: true });
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center px-4 py-10">
      <Link to="/app/campaigns" className="-mt-1 mb-5 inline-flex items-center gap-1.5 py-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} /> Campaigns
      </Link>
      <Card className="p-6">
        <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand-text">
          <Rocket size={20} />
        </span>
        <h1 className="text-xl font-semibold">Let's create a new campaign</h1>
        <p className="mt-1 text-[13px] text-muted">Give it a name you'll recognise later. You'll add leads, write the sequence and pick a schedule next.</p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <Field label="Campaign name" error={name.trim() && !valid ? "Use at least 3 characters." : null}>
            {(id) => <Input id={id} autoFocus value={name} placeholder={DEFAULT_NAME} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => navigate("/app/campaigns")}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
              Continue
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
