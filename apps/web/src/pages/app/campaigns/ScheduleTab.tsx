import { ScheduleEditor } from "@/components/sequence/ScheduleEditor";
import { useCampaign } from "./context";

export default function ScheduleTab() {
  const { campaign, save, readOnly, setPending } = useCampaign();
  return (
    <ScheduleEditor
      schedule={campaign.campaign_schedule}
      onSave={(s) => save({ campaign_schedule: s })}
      readOnly={readOnly}
      onUnsaved={(s) => setPending(s && { what: "schedule", save: s })}
      scope={campaign.id}
    />
  );
}
