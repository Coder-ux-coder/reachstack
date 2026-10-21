import { Navigate } from "react-router";
import { LeadsTable } from "@/components/leads/LeadsTable";
import { useCan } from "@/lib/session";
import { useCampaign } from "./context";

export default function LeadsTab() {
  const { campaign } = useCampaign();
  const can = useCan();
  // A member whose role doesn't include leads sees the campaign's sequence instead.
  if (!can.perm("leads")) return <Navigate to="../sequences" replace />;
  return <LeadsTable campaignId={campaign.id} />;
}
