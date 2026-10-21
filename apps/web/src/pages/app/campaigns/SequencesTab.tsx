import { useQueryClient } from "@tanstack/react-query";
import { CampaignStatus } from "@reachstack/shared";
import { SequenceEditor } from "@/components/sequence/SequenceEditor";
import { useCampaign } from "./context";

export default function SequencesTab() {
  const { campaign, save, readOnly, setPending } = useCampaign();
  const qc = useQueryClient();
  return (
    <SequenceEditor
      steps={campaign.sequences[0]?.steps ?? []}
      onSave={(steps) => save({ sequences: [{ steps }] })}
      campaignId={campaign.id}
      customVariables={Object.keys(campaign.custom_variables ?? {})}
      readOnly={readOnly}
      launched={campaign.status !== CampaignStatus.DRAFT}
      textOnly={!!campaign.text_only}
      versions={{ path: `/api/app/campaigns/${campaign.id}`, onRestored: () => qc.invalidateQueries({ queryKey: ["campaign", campaign.id] }) }}
      onUnsaved={(s) => setPending(s && { what: "sequence", save: s })}
    />
  );
}
