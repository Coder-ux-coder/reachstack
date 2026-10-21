// Copilot settings, per user and workspace: when Copilot asks first, follow-ups, Slack, the chat model.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button, Callout, NativeSelect, NumberInput, Section, Skeleton, SwitchRow } from "@/components/ui";
import { errorMessage, put } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { CHAT_MODEL_LABELS, SETTINGS_KEY, useCopilotSettings, type CopilotSettings, type CopilotSettingsData } from "./api";

function Row({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 max-w-md">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-[13px] text-muted">{description}</p>
      </div>
      {children}
    </div>
  );
}

export function CopilotSettingsPage() {
  usePageTitle("Copilot settings");
  const q = useCopilotSettings();
  const [limit, setLimit] = useState<number | null>(null);
  useEffect(() => {
    if (q.data) setLimit(q.data.settings.enrich_leads_limit);
  }, [q.data]);

  const save = async (change: Partial<CopilotSettings>) => {
    const before = queryClient.getQueryData<CopilotSettingsData>(SETTINGS_KEY);
    queryClient.setQueryData<CopilotSettingsData>(SETTINGS_KEY, (d) => d && { ...d, settings: { ...d.settings, ...change } });
    try {
      const r = await put<{ settings: CopilotSettings }>("/api/app/copilot/settings", change);
      queryClient.setQueryData<CopilotSettingsData>(SETTINGS_KEY, (d) => d && { ...d, settings: r.settings });
      toast.success("Saved");
    } catch (e) {
      if (before) queryClient.setQueryData(SETTINGS_KEY, before);
      toast.error(errorMessage(e));
    }
  };

  if (q.isLoading)
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-6 sm:px-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (!q.data)
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <Callout tone="bad" title="Couldn't load settings">
          {errorMessage(q.error)}
        </Callout>
      </div>
    );

  const { settings: s, models, workspace_model, slack_connections, ai_available } = q.data;
  const limitChanged = limit !== null && limit !== s.enrich_leads_limit;
  const limitValid = limit !== null && Number.isInteger(limit) && limit >= 1 && limit <= 50_000;
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-[13px] text-muted">These apply to your chats in this workspace only.</p>
        {!ai_available && (
          <Callout tone="warn" className="mt-4">
            Copilot needs AI: add an Anthropic API key in{" "}
            <Link to="/app/settings/integrations#ai" className="underline">
              Settings → Integrations & API → AI
            </Link>
            , or ask the person who runs this installation to set one up in Settings → Installation → Services.
          </Callout>
        )}

        <Section title="Approvals" description="Copilot always shows what it did. These decide when it asks before acting.">
          <div className="divide-y divide-line">
            <SwitchRow
              label="Run steps automatically"
              description="Copilot reads your campaigns, accounts and leads without asking. Turn off to approve every step, reads included."
              checked={s.execute_tools}
              onChange={(v) => void save({ execute_tools: v })}
            />
            <SwitchRow
              label="WARP mode"
              description="Copilot also creates campaigns, adds leads, sets up agents and changes campaign status without asking first. Purchases always need your confirmation."
              checked={s.warp_mode}
              disabled={!s.execute_tools}
              onChange={(v) => void save({ warp_mode: v })}
            >
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <p className="mb-1.5 text-[13px] font-medium">Most leads added at once</p>
                  <NumberInput value={limit} min={1} max={50_000} onChange={setLimit} aria-label="Most leads added at once" suffix="leads" className="w-40" />
                </div>
                {limitChanged && (
                  <Button size="sm" variant="primary" disabled={!limitValid} onClick={() => limit !== null && void save({ enrich_leads_limit: limit })}>
                    Save
                  </Button>
                )}
              </div>
              <p className="mt-1.5 text-xs text-muted">Larger requests are capped to this number while WARP mode is on.</p>
            </SwitchRow>
          </div>
        </Section>

        <Section title="Chat">
          <div className="divide-y divide-line">
            <SwitchRow label="Follow-up suggestions" description="Show up to three next questions under an answer." checked={s.follow_up_suggestions} onChange={(v) => void save({ follow_up_suggestions: v })} />
            <SwitchRow label="Time saved" description="Count the actions Copilot takes and estimate the time it saved you, on the new chat page." checked={s.analytics} onChange={(v) => void save({ analytics: v })} />
            <Row label="Model" description="The Claude model that answers your chats. Larger models are slower and cost more per answer.">
              <NativeSelect
                className="w-56"
                aria-label="Model"
                value={s.chat_model ?? ""}
                onChange={(v) => void save({ chat_model: v || null })}
                options={[{ value: "", label: `Workspace default${workspace_model ? ` (${CHAT_MODEL_LABELS[workspace_model] ?? workspace_model})` : ""}` }, ...models.map((m) => ({ value: m, label: CHAT_MODEL_LABELS[m] ?? m }))]}
              />
            </Row>
          </div>
        </Section>

        <Section title="Notifications">
          <Row label="Slack" description="Where results of recurring tasks are posted, besides the in-app notification.">
            {slack_connections.length ? (
              <NativeSelect
                className="w-56"
                aria-label="Slack connection"
                value={s.slack_integration_id ?? ""}
                onChange={(v) => void save({ slack_integration_id: v || null })}
                options={[{ value: "", label: "Don't post to Slack" }, ...slack_connections.map((c) => ({ value: c.id, label: c.name }))]}
              />
            ) : (
              <Link to="/app/settings/integrations" className="-my-1 py-1 text-[13px] font-medium text-brand-text hover:underline">
                Connect Slack
              </Link>
            )}
          </Row>
        </Section>
      </div>
    </div>
  );
}
