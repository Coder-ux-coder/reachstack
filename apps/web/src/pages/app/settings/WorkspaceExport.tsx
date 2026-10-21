// "Download all data" on Settings → Workspace & members, for the workspace's owners and admins: everything in the
// workspace as one .tar.gz of CSV and JSON files, prepared in the background and kept for 7 days.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, PackageOpen, RefreshCcw } from "lucide-react";
import { errorMessage, get, post } from "@/lib/api";
import { ago, bytes, dateOnly } from "@/lib/format";
import { Button, buttonClass, Callout, Progress, Section } from "@/components/ui";

interface WorkspaceExport {
  id: string;
  status: "pending" | "in-progress" | "success" | "failed" | "cancelled";
  progress: number;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
  bytes: number | null;
  counts: Record<string, number> | null;
  expires_at: string | null;
  /** Ready and not deleted yet. */
  available: boolean;
  file_name: string | null;
}

const KEY = ["workspace-export"];
const preparing = (e: WorkspaceExport | undefined) => !!e && (e.status === "pending" || e.status === "in-progress");

export function WorkspaceExportSection() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => get<{ items: WorkspaceExport[] }>("/api/app/workspace-export"),
    refetchInterval: (query) => (preparing(query.state.data?.items[0]) ? 2000 : false),
  });
  const latest = q.data?.items[0];
  const [busy, setBusy] = useState(false);

  const prepare = async () => {
    setBusy(true);
    try {
      const job = await post<WorkspaceExport>("/api/app/workspace-export");
      qc.setQueryData<{ items: WorkspaceExport[] }>(KEY, (cur) => ({ items: [job, ...(cur?.items ?? []).filter((x) => x.id !== job.id)] }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!q.data) body = q.isError ? <Callout tone="bad">{errorMessage(q.error)}</Callout> : <p className="text-[13px] text-muted">Loading…</p>;
  else if (latest && preparing(latest)) {
    body = (
      <div className="rounded-xl border border-line bg-panel p-4">
        <p className="text-[13px] font-medium">Preparing your download…</p>
        <Progress value={latest.progress} className="mt-2" />
        <p className="mt-2 text-xs text-muted">You can leave this page. It keeps going, and the download waits here when it's ready.</p>
      </div>
    );
  } else if (latest?.status === "success" && latest.available) {
    body = (
      <div className="rounded-xl border border-line bg-panel p-4">
        <p className="break-all text-[13px] font-medium">{latest.file_name ?? "Workspace data"}</p>
        <p className="mt-0.5 text-xs text-muted">
          {bytes(latest.bytes)} · prepared {ago(latest.finished_at)} · ready until {dateOnly(latest.expires_at)}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={`/api/app/workspace-export/${encodeURIComponent(latest.id)}/download`} download className={buttonClass("primary", "sm")}>
            <Download size={14} />
            Download
          </a>
          <Button size="sm" icon={<RefreshCcw size={14} />} loading={busy} onClick={prepare}>
            Prepare a new one
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        {latest?.status === "failed" && (
          <Callout tone="bad" title="The download couldn't be prepared">
            {latest.error ?? "Try again in a moment."}
          </Callout>
        )}
        {latest?.status === "success" && !latest.available && <p className="text-[13px] text-muted">The last download was deleted after 7 days. Prepare a new one when you need it.</p>}
        <Button icon={<PackageOpen size={14} />} loading={busy} onClick={prepare}>
          {latest?.status === "failed" ? "Try again" : "Prepare a download"}
        </Button>
      </div>
    );
  }

  return (
    <Section
      title="Download all data"
      description="Everything in this workspace in one file: leads, lists, campaigns, email accounts, emails, the block list and tags. Passwords and keys are never included."
    >
      <div className="space-y-3">
        {body}
        <p className="text-xs text-muted">It's a .tar.gz file of CSV and JSON files. Windows 11, macOS and Linux open it without extra software.</p>
      </div>
    </Section>
  );
}
