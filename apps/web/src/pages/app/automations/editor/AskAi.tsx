// "Ask AI": describe an automation (or a change to this one) and get the steps drafted on the canvas.
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import type { AutomationGraph } from "@reachstack/shared";
import { errorMessage, post } from "@/lib/api";
import { Button, Callout, Dialog, Textarea } from "@/components/ui";
import { BASE } from "../api";

const IDEAS = [
  "When a lead replies, have AI rate how interested they are; if 7 or more, label them Interested and post to Slack.",
  "When a lead clicks the pricing link, create a call task for their owner due tomorrow.",
  "Every Monday at 9:00, email the team a reminder to review the week's replies.",
  "When a request arrives at a webhook, add the person as a lead to a campaign.",
];

export interface AiDraft {
  name: string;
  explanation: string;
  graph: AutomationGraph;
}

export function AskAiDialog({ open, onOpenChange, graph, available, onDraft }: { open: boolean; onOpenChange: (v: boolean) => void; graph: AutomationGraph; available: boolean; onDraft: (d: AiDraft) => void }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const editing = graph.nodes.length > 0;
  const build = async () => {
    if (!available || prompt.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      const draft = await post<AiDraft>(`${BASE}/ai-build`, { prompt: prompt.trim(), graph: editing ? graph : undefined });
      onDraft(draft);
      onOpenChange(false);
      setPrompt("");
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
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={16} className="text-brand" /> Ask AI
        </span>
      }
      description={editing ? "Describe what to change. The AI redraws the automation; you can undo it." : "Describe what should happen. The AI drafts the trigger and steps for you to check and test."}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={build} loading={busy} disabled={!available || prompt.trim().length < 3}>
            {busy ? "Drafting…" : editing ? "Change it" : "Draft it"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!available && (
          <Callout tone="warn" title="Ask AI needs an Anthropic API key">
            Add one in{" "}
            <Link to="/app/settings/integrations#ai" className="font-medium text-brand-text hover:underline">
              Settings → Integrations & API → AI
            </Link>
            .
          </Callout>
        )}
        <Textarea
          autoFocus
          rows={5}
          value={prompt}
          maxLength={4_000}
          disabled={busy}
          aria-label="What should the automation do?"
          placeholder={editing ? "e.g. Also add a note to the lead after posting to Slack" : "e.g. When a lead replies with interest, label them Interested and tell the team in Slack"}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void build();
          }}
        />
        {!editing && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Ideas</p>
            <ul className="space-y-1">
              {IDEAS.map((idea) => (
                <li key={idea}>
                  <button type="button" disabled={busy} onClick={() => setPrompt(idea)} className="w-full rounded-md px-2 py-1.5 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-text">
                    {idea}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
