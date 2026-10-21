// "Restart now" for the installation's owner, where the server can restart itself (started with npm run local, or a
// supervisor that says so): it asks first, waits until the server is back, then reloads the page.
import { useState } from "react";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { errorMessage, get, post } from "@/lib/api";
import { Button, useConfirm } from "@/components/ui";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Changes with every start of the server; null while it doesn't answer. */
async function bootId(): Promise<string | null> {
  try {
    return (await get<{ boot?: string }>("/api/health")).boot ?? null;
  } catch {
    return null;
  }
}

export function RestartButton({
  label = "Restart now",
  title = "Restart the server?",
  description = "The app is unavailable for a few seconds, then this page reloads. Emails due in that time go out right after.",
  confirmLabel = "Restart",
  variant,
}: {
  label?: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  variant?: "primary";
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function restart() {
    if (!(await confirm({ title, description, confirmLabel }))) return;
    setBusy(true);
    const before = await bootId();
    try {
      await post("/api/app/admin/restart");
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
      return;
    }
    const id = toast.loading("Restarting the server…");
    for (let i = 0; i < 120; i++) {
      await pause(1_000);
      const now = await bootId();
      if (now && now !== before) {
        toast.success("The server restarted.", { id });
        window.location.reload();
        return;
      }
    }
    toast.error("The server hasn't come back after two minutes. Look at the window it runs in for what stopped it.", { id });
    setBusy(false);
  }

  return (
    <Button size="sm" variant={variant} loading={busy} icon={<RotateCw size={14} aria-hidden />} onClick={restart}>
      {label}
    </Button>
  );
}
