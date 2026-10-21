// Registers every background loop. Imported by the server (in-process engine) and the standalone worker.
import { registerLoop } from "./index";
import { runBackups } from "./backups";
import { syncDueAccounts } from "./inbox-sync";
import { runPendingJobs } from "./jobs";
import { runSender } from "./sender";
import { runWarmup, updateWarmupScores } from "./warmup";
import { deliverDueWebhooks, pruneWebhookEvents } from "../services/webhooks";
import { pruneUploads, runScheduledEmails } from "../services/unibox";
import { checkPlacement, runDuePlacementTests } from "../services/placement";
import { detectLeadEsps } from "../services/verification";
import { fillLeadTimezones } from "../services/lead-zones";
import { runInboxManagers } from "../services/agents/inbox-manager";
import { runLeadFinderAgents } from "../services/agents/lead-finder-agent";
import { processDeliverability, scheduleDeliverability } from "../services/agents/deliverability-agent";
import { runSalesAgents } from "../services/agents/sales-agent";
import { runDueTasks } from "../services/copilot/tasks";
import { runVisitorLookups } from "../services/visitors";
import { runAutomations } from "../services/automations/engine";
import { runDueSchedules } from "../services/automations/schedule";
import { runReminders } from "../services/reminders";
import { runSequenceTasks } from "../services/sequence-tasks";
import { runWatchdog } from "../services/watchdog";
import { purgeDeleted } from "../services/recently-deleted";
// Starts automations from engine events (replies, sends, bounces…) in this process.
import "../services/automations/triggers";
import "../services/account-connect";
import "../routes/accounts";
import "../routes/leads";
import "../routes/deliverability";
import "../routes/lead-finder";
import "../services/lead-finder/company-lists";
import "../services/lead-finder/dataset";
import "../services/lead-finder/enrichment";
import "../services/lead-finder/imports";

registerLoop("sender", 5_000, runSender);
// Task steps: a lead that reaches one gets its task, and waits for it.
registerLoop("sequence-tasks", 15_000, () => runSequenceTasks());
registerLoop("inbox-sync", 10_000, syncDueAccounts);
registerLoop("warmup", 60_000, runWarmup);
registerLoop("warmup-scores", 15 * 60_000, updateWarmupScores);
registerLoop("webhooks", 5_000, async () => {
  await deliverDueWebhooks();
});
registerLoop("jobs", 2_000, runPendingJobs);
registerLoop("scheduled-emails", 15_000, runScheduledEmails);
registerLoop("placement-runner", 60_000, runDuePlacementTests);
registerLoop("placement-checker", 20_000, checkPlacement);
registerLoop("esp-detection", 30_000, detectLeadEsps);
// Leads without a timezone get one from their location, custom fields or phone ("each lead's timezone").
registerLoop("lead-timezones", 30_000, () => fillLeadTimezones());
registerLoop("inbox-manager", 20_000, runInboxManagers);
registerLoop("lead-finder-agent", 60_000, runLeadFinderAgents);
registerLoop("deliverability-scheduler", 60_000, scheduleDeliverability);
registerLoop("deliverability-checks", 3_000, () => processDeliverability());
registerLoop("sales-agent", 15_000, runSalesAgents);
registerLoop("copilot-tasks", 30_000, runDueTasks);
registerLoop("website-visitors", 60_000, runVisitorLookups);
registerLoop("blocklist-sheets", 30 * 60_000, refreshBlockSheets);
registerLoop("automations", 3_000, runAutomations);
registerLoop("automation-schedules", 30_000, runDueSchedules);
registerLoop("backups", 60_000, runBackups);
registerLoop("reminders", 30_000, () => runReminders());
registerLoop("send-watchdog", 2 * 60_000, () => runWatchdog());
// Sending domains' DNS records, each checked again once a day.
registerLoop("domain-dns", 60 * 60_000, () => refreshDomainChecks());
// Custom tracking domains: links use one only while HTTPS reaches this installation under it.
registerLoop("tracking-domains", 60 * 60_000, () => recheckTrackingDomains());
// Recently deleted keeps things for 30 days; once a day older entries go for good.
registerLoop("recently-deleted", 24 * 60 * 60_000, async () => {
  await purgeDeleted();
});
// The webhook delivery log keeps 30 days.
registerLoop("webhook-log", 24 * 60 * 60_000, async () => {
  await pruneWebhookEvents();
});
// Files uploaded for an email that never went out go after a week.
registerLoop("unsent-uploads", 24 * 60 * 60_000, async () => {
  await pruneUploads();
});
import "../services/subsequences";
import "../services/reply-labels";
import "../services/notifications";
import { refreshBlockSheets } from "../services/blocklist";
import { refreshDomainChecks } from "../services/domain-dns";
import { recheckTrackingDomains } from "../services/tracking-domains";
