import type { ComponentType } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation, type RouteObject } from "react-router";
import { RedirectIfAuthed, RequireAuth } from "@/lib/session";
import { UnsavedChangesPrompt } from "@/lib/unsaved";
import { AppShell } from "@/components/shell/AppShell";
import { RouteError, NotFound } from "@/pages/errors";
import { FullPageSpinner } from "@/components/ui/spinner";

/** Lazy route module: `page(() => import("./x"))` or `page(() => import("./x"), "Named")`. */
function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string = "default" as keyof M & string) {
  return async () => ({ Component: (await load())[name] as ComponentType });
}

const r = (path: string, lazy: RouteObject["lazy"], extra: Partial<RouteObject> = {}): RouteObject => ({ path, lazy, ...extra }) as RouteObject;

const auth = () => import("@/pages/auth/misc");
const subsequences = () => import("@/pages/app/campaigns/Subsequences");
const billing = () => import("@/pages/app/settings/Billing");
const labels = () => import("@/pages/app/settings/Labels");
const moreSettings = () => import("@/pages/app/settings/More");
const verification = () => import("@/pages/app/verification/Verification");
const placement = () => import("@/pages/app/inbox-placement/InboxPlacement");
const agents = () => import("@/pages/app/agents/Agents");
const salesAgent = () => import("@/pages/app/agents/SalesAgent");
const crmInbox = () => import("@/pages/app/crm/Inbox");
const crmLeads = () => import("@/pages/app/crm/Leads");
const crmReports = () => import("@/pages/app/crm/Reports");
const copilot = () => import("@/pages/app/copilot/Chat");
const visitors = () => import("@/pages/app/website-visitors/Visitors");
const privacy = () => import("@/pages/public/Privacy");
const unsubscribe = () => import("@/pages/public/Unsubscribe");
const installation = () => import("@/pages/app/settings/Installation");

const appRoutes: RouteObject[] = [
  { index: true, element: <Navigate to="/app/dashboard" replace /> },
  r("dashboard", page(() => import("@/pages/app/Dashboard"))),
  r("today", page(() => import("@/pages/app/today/Today"))),
  r("onboarding", page(() => import("@/pages/app/Onboarding"))),
  {
    path: "copilot",
    lazy: page(copilot, "CopilotLayout"),
    children: [
      { index: true, lazy: page(copilot, "NewChat") },
      { path: "memory", element: <Navigate to="/app/copilot/memory/business-details" replace /> },
      r("memory/:tab", page(() => import("@/pages/app/copilot/Memory"), "CopilotMemory")),
      r("tasks", page(() => import("@/pages/app/copilot/Tasks"), "CopilotTasks")),
      r("settings", page(() => import("@/pages/app/copilot/Settings"), "CopilotSettingsPage")),
      r(":id", page(copilot, "ChatThread")),
    ],
  },
  r("redirect", page(() => import("@/pages/app/Workspace"), "AppRedirect")),
  r("w/:workspace_id", page(() => import("@/pages/app/Workspace"), "WorkspaceJump")),
  r("settings/change-owner", page(auth, "ConfirmOwnerChange")),
  r("settings/expired", page(billing, "TrialExpired")),
  { path: "settings/delete-user", element: <Navigate to="/app/settings/account#delete-account" replace /> },
  { path: "blocklist", element: <Navigate to="/app/settings/blocklist" replace /> },
  {
    path: "verification",
    lazy: page(verification, "VerificationLayout"),
    children: [
      { index: true, element: <Navigate to="single" replace /> },
      r("single", page(verification, "VerifySingle")),
      r("bulk", page(verification, "VerifyBulk")),
      r("leads", page(verification, "VerifyLeads")),
      r("list", page(verification, "VerifyList")),
      r("billing", page(verification, "VerifyCredits")),
    ],
  },
  {
    lazy: page(() => import("@/pages/app/settings/SettingsLayout")),
    children: [
      { path: "settings", element: <Navigate to="/app/settings/account" replace /> },
      r("settings/account", page(() => import("@/pages/app/settings/Profile"))),
      r("settings/preferences", page(() => import("@/pages/app/settings/Preferences"))),
      r("crm/workspace-and-members", page(() => import("@/pages/app/settings/Members"))),
      r("crm/calls-and-sms", page(() => import("@/pages/app/settings/CallsAndSms"))),
      r("settings/workspace-group", page(moreSettings, "WorkspaceGroup")),
      r("settings/lead-labels", page(labels)),
      r("settings/custom-tags", page(labels, "CustomTags")),
      r("settings/custom-variables", page(() => import("@/pages/app/settings/CustomVariables"))),
      r("settings/billing", page(billing)),
      r("settings/cancel", page(billing, "CancelPlan")),
      r("settings/audit-logs", page(moreSettings, "AuditLogs")),
      r("settings/recently-deleted", page(() => import("@/pages/app/settings/RecentlyDeleted"))),
      r("settings/integrations", page(() => import("@/pages/app/settings/Integrations"))),
      r("settings/blocklist", page(() => import("@/pages/app/settings/Blocklist"))),
      r("settings/advanced-deliverability", page(() => import("@/pages/app/settings/AdvancedDeliverability"))),
      r("settings/custom-warmup-copy", page(moreSettings, "WarmupCopy")),
      r("settings/agency", page(moreSettings, "Agency")),
      r("settings/privacy", page(() => import("@/pages/app/settings/PrivacyCenter"))),
      {
        path: "settings/installation",
        lazy: page(installation, "InstallationLayout"),
        children: [
          { index: true, lazy: page(installation, "InstallationOverview") },
          r("people", page(installation, "InstallationPeople")),
          r("workspaces", page(installation, "InstallationWorkspaces")),
          r("access", page(installation, "InstallationAccess")),
          r("services", page(() => import("@/pages/app/settings/installation/Services"), "InstallationServices")),
          r("backups", page(() => import("@/pages/app/settings/installation/Backups"), "InstallationBackups")),
          r("health", page(() => import("@/pages/app/settings/installation/Health"), "InstallationHealth")),
        ],
      },
    ],
  },
  r("accounts", page(() => import("@/pages/app/accounts/Accounts"))),
  r("account/connect", page(() => import("@/pages/app/accounts/Connect"))),
  r("unibox", page(() => import("@/pages/app/unibox/Unibox"))),
  { path: "analytics", element: <Navigate to="/app/analytics/overview" replace /> },
  r("analytics/overview", page(() => import("@/pages/app/analytics/Analytics"))),
  r("lead-finder", page(() => import("@/pages/app/lead-finder/LeadFinder"))),
  r("lead-finder/leads", page(() => import("@/pages/app/lead-finder/LeadLists"))),
  r("campaigns", page(() => import("@/pages/app/campaigns/Campaigns"))),
  r("templates", page(() => import("@/pages/app/Templates"))),
  r("inbox-placement", page(placement, "PlacementTests")),
  r("inbox-placement/create", page(placement, "PlacementEditor")),
  {
    path: "inbox-placement/:test_id",
    lazy: page(placement, "PlacementLayout"),
    children: [
      { index: true, element: <Navigate to="results" replace /> },
      r("results", page(placement, "PlacementResults")),
      r("test-details", page(placement, "PlacementDetails")),
    ],
  },
  r("ai-agents", page(agents)),
  r("ai-agents/create", page(agents, "CreateAgent")),
  r("ai-agents/deliverability", page(() => import("@/pages/app/agents/DeliverabilityAgent"))),
  {
    path: "ai-agents/:agent_id",
    lazy: page(agents, "AgentLayout"),
    children: [
      { index: true, lazy: page(agents, "AgentOverview") },
      r("configuration", page(agents, "AgentConfiguration")),
      r("details", page(agents, "AgentDetails")),
    ],
  },
  {
    path: "crm",
    lazy: page(() => import("@/pages/app/crm/CrmLayout")),
    children: [
      { index: true, lazy: page(crmInbox) },
      ...["emails", "calls", "sms", "tasks", "upcoming", "archive", "archive/:type"].map((p) => r(p, page(crmInbox))),
      r("opportunities", page(() => import("@/pages/app/crm/Opportunities"))),
      r("leads", page(crmLeads)),
      r("dynamic-views", page(crmLeads, "SalesFlows")),
      r("reports", page(crmReports)),
      r("activity-comparison", page(crmReports, "ActivityComparison")),
    ],
  },
  { path: "crm/lead-statuses", element: <Navigate to="/app/settings/lead-labels" replace /> },
  { path: "crm/automations", element: <Navigate to="/app/automations" replace /> },
  r("automations", page(() => import("@/pages/app/automations/Automations"))),
  r("automations/history", page(() => import("@/pages/app/automations/History"))),
  r("automations/:workflow_id", page(() => import("@/pages/app/automations/Editor"))),
  { path: "crm/website-visitors", element: <Navigate to="/app/website-visitors" replace /> },
  {
    path: "website-visitors",
    lazy: page(visitors, "VisitorsLayout"),
    children: [
      { index: true, lazy: page(visitors, "VisitorsPage") },
      r("setup", page(() => import("@/pages/app/website-visitors/Setup"), "VisitorSetup")),
      r("billing", page(() => import("@/pages/app/website-visitors/Billing"), "VisitorBilling")),
    ],
  },
  { path: "website-visitor", element: <Navigate to="/app/website-visitors" replace /> },
  r("oauth/callback/stripe", page(crmReports, "StripeCallback")),
  r("ai-sales-agent", page(salesAgent, "SalesRedirect")),
  r("ai-sales-agent/create", page(salesAgent, "SalesAgentCreate")),
  {
    path: "ai-sales-agent/:id",
    lazy: page(salesAgent, "SalesAgentLayout"),
    children: [
      { index: true, lazy: page(salesAgent, "SalesAgentIndex") },
      r("live-feed", page(salesAgent, "SalesLiveFeed")),
      r("memory", page(salesAgent, "SalesMemory")),
      r("leads", page(salesAgent, "SalesLeads")),
      r("settings", page(salesAgent, "SalesSettings")),
    ],
  },
  r("campaign/create", page(() => import("@/pages/app/campaigns/CreateCampaign"))),
  {
    path: "campaign/:id",
    lazy: page(() => import("@/pages/app/campaigns/CampaignLayout")),
    children: [
      { index: true, element: <Navigate to="analytics" replace /> },
      r("analytics", page(() => import("@/pages/app/campaigns/AnalyticsTab"))),
      r("leads", page(() => import("@/pages/app/campaigns/LeadsTab"))),
      r("sequences", page(() => import("@/pages/app/campaigns/SequencesTab"))),
      r("schedule", page(() => import("@/pages/app/campaigns/ScheduleTab"))),
      r("options", page(() => import("@/pages/app/campaigns/OptionsTab"))),
      r("subsequences", page(subsequences)),
      r("subsequences/create", page(subsequences, "SubsequenceCreate")),
      {
        path: "subsequences/:subId",
        lazy: page(subsequences, "SubsequenceLayout"),
        children: [
          { index: true, element: <Navigate to="sequences" replace /> },
          r("sequences", page(subsequences, "SubsequenceSequences")),
          r("schedule", page(subsequences, "SubsequenceSchedule")),
          r("analytics", page(subsequences, "SubsequenceAnalytics")),
          r("options", page(subsequences, "SubsequenceOptions")),
        ],
      },
    ],
  },
  { path: "*", element: <NotFound /> },
];

/** Short addresses people type (/login, /signup…) open the real page, keeping any ?query (an invite, a return path). */
function Alias({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

const routes: RouteObject[] = [
  {
    element: (
      <>
        <UnsavedChangesPrompt />
        <Outlet />
      </>
    ),
    errorElement: <RouteError />,
    // Shown while the first page's code loads (React Router warns on every full load without one).
    hydrateFallbackElement: <FullPageSpinner />,
    children: [
      r("/", page(() => import("@/pages/marketing/Home"))),
      ...["/login", "/signin", "/sign-in"].map((path) => ({ path, element: <Alias to="/auth/login" /> })),
      ...["/signup", "/sign-up", "/register"].map((path) => ({ path, element: <Alias to="/auth/signup" /> })),
      {
        element: (
          <RedirectIfAuthed>
            <Outlet />
          </RedirectIfAuthed>
        ),
        children: [
          r("/auth/login", page(() => import("@/pages/auth/Login"))),
          r("/auth/signup", page(() => import("@/pages/auth/Signup"))),
          r("/client/sign-up", page(() => import("@/pages/auth/Signup"), "ClientSignup")),
          r("/client/login", page(() => import("@/pages/auth/Login"), "ClientLogin")),
        ],
      },
      r("/auth/reset-password", page(auth, "ResetPassword")),
      r("/auth/verify", page(auth, "VerifyEmail")),
      r("/auth/oauthfinal", page(auth, "OAuthFinal")),
      r("/auth/oauth-handler", page(auth, "OAuthHandler")),
      r("/auth/oauth/authorize", page(auth, "OAuthAuthorize")),
      r("/invitations", page(auth, "Invitations")),
      r("/workspace-group-invitation/:token", page(auth, "WorkspaceGroupInvitation")),
      // Public pages: the privacy center, unsubscribe choices, shared campaigns and partner links.
      { path: "/privacy", element: <Navigate to="/privacy/info" replace /> },
      r("/privacy/info", page(privacy, "PrivacyInfo")),
      r("/privacy/opt-out", page(privacy, "OptOut")),
      r("/privacy/opt-out/confirm", page(privacy, "OptOutDone")),
      r("/privacy/data-request", page(privacy, "DataRequest")),
      r("/privacy/data-request/confirm", page(privacy, "DataRequestConfirm")),
      r("/privacy/manager", page(privacy, "PrivacyManager")),
      r("/privacy/report-abuse", page(privacy, "ReportAbuseStart")),
      r("/privacy/report-abuse/:id", page(privacy, "ReportAbuse")),
      r("/email-marketing/unsubscribe", page(unsubscribe, "SenderUnsubscribe")),
      r("/broadcasts/unsubscribe", page(unsubscribe, "CampaignUnsubscribe")),
      r("/share/campaign", page(() => import("@/pages/public/ShareCampaign"), "ShareCampaign")),
      r("/mobile-app", page(() => import("@/pages/marketing/MobileApp"))),
      r("/developers", page(() => import("@/pages/marketing/Developers"))),
      r("/p/:partner", page(() => import("@/pages/marketing/Partner"))),
      {
        path: "/user",
        element: (
          <RequireAuth>
            <Outlet />
          </RequireAuth>
        ),
        children: [r("sign-website-visitor-tos", page(() => import("@/pages/app/website-visitors/Terms"), "VisitorTerms"))],
      },
      {
        path: "/app",
        element: (
          <RequireAuth>
            <Outlet />
          </RequireAuth>
        ),
        children: [
          // Screens that work without a selected workspace, outside the app chrome.
          r("organization/create", page(() => import("@/pages/app/Workspace"), "CreateWorkspace")),
          // What a workspace asks first: a fresh authenticator code, or two-step authentication turned on.
          r("security/workspace", page(() => import("@/pages/app/Workspace"), "WorkspaceSecurity")),
          r("security/two-step", page(() => import("@/pages/app/Workspace"), "TwoStepRequired")),
          r("signup-know-user", page(() => import("@/pages/app/Onboarding"), "KnowUser")),
          { element: <AppShell />, children: appRoutes },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
