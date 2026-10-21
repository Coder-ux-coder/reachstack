import { Link, Navigate } from "react-router";
import { Bot, Flame, Inbox, Layers, Mail, Search, ShieldCheck, Users, Workflow } from "lucide-react";
import { useMe, usePublicConfig } from "@/lib/session";
import { buttonClass } from "@/components/ui";
import { CtaBand, Faq, FeatureGrid, Hero, MarketingLayout, SectionTitle, useSignupOpen } from "./Layout";

const STEPS = [
  ["Connect mailboxes", "Add Google, Microsoft or any IMAP/SMTP account. Each mailbox keeps its own daily limit and sending gap."],
  ["Warm them up", "Warmup trades realistic conversations across the pool so providers learn your domains are legitimate."],
  ["Add leads", "Import a CSV, paste a list or search the lead finder. Emails are verified before they cost you a bounce."],
  ["Write the sequence", "Steps, follow-up delays, A/B variants, spintax and personalization variables — with a preview for every lead."],
  ["Launch and reply", "Sending rotates across accounts inside your schedule. Replies land in one inbox, labelled by interest."],
] as const;

export default function Home() {
  const me = useMe();
  const signupOpen = useSignupOpen();
  // A new installation: whoever opens it is setting it up, so it starts with creating the owner account.
  if (usePublicConfig().data?.first_run) return <Navigate to="/auth/signup" replace />;
  return (
    <MarketingLayout title="Cold email outreach">
      <Hero
        eyebrow="Self-hosted cold outreach platform"
        title={
          <>
            Send from every mailbox.
            <br />
            <span className="text-brand-text">Answer from one inbox.</span>
          </>
        }
        body="Connect unlimited sending accounts, warm them up, find prospects, run multi-step campaigns and work every reply — on infrastructure you control."
      >
        {me.data ? (
          <Link to="/app/dashboard" className={buttonClass("primary", "lg")}>
            Open app
          </Link>
        ) : (
          <>
            {signupOpen && (
              <Link to="/auth/signup" className={buttonClass("primary", "lg")}>
                Start free
              </Link>
            )}
            <Link to="/auth/login" className={buttonClass(signupOpen ? "secondary" : "primary", "lg")}>
              Log in
            </Link>
          </>
        )}
      </Hero>

      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-xl">
          <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#f59e0b]/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#10b981]/70" />
          </div>
          <div className="grid gap-px bg-line sm:grid-cols-4">
            {[
              ["Mailboxes", "Unlimited", "rotated per campaign"],
              ["Warmup", "Automatic", "for every connected account"],
              ["Inbox", "One view", "for replies from all accounts"],
              ["API", "250+ endpoints", "plus signed webhooks"],
            ].map(([k, v, s]) => (
              <div key={k} className="bg-panel p-6">
                <p className="text-[13px] text-muted">{k}</p>
                <p className="mt-2 text-2xl font-semibold tracking-tight">{v}</p>
                <p className="mt-1 text-xs text-faint">{s}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="scroll-mt-16 border-y border-line bg-panel px-4 py-20 sm:px-6">
        <SectionTitle eyebrow="Everything in one place" title="The whole outbound stack" body="No separate tools for sending, warmup, prospect data, replies and pipeline." />
        <div className="mx-auto mt-12 max-w-6xl">
          <FeatureGrid
            items={[
              { icon: <Mail size={18} />, title: "Unlimited sending accounts", body: "Connect as many mailboxes as you like. Campaigns rotate across them with per-account limits, gaps and slow ramp-up." },
              { icon: <Flame size={18} />, title: "Warmup built in", body: "Every mailbox can join the warmup pool. Opens, replies and spam rescues happen automatically, with a health score per account." },
              { icon: <Layers size={18} />, title: "Sequences that adapt", body: "Multi-step campaigns with variants, spintax, conditional subsequences and automatic winner selection." },
              { icon: <Inbox size={18} />, title: "Unified inbox", body: "Replies from every account in one place. Label interest, reply, forward, schedule follow-ups and snooze." },
              { icon: <Search size={18} />, title: "Lead finder", body: "Filter prospects by title, industry, size and location; verify and enrich them; push straight into campaigns." },
              { icon: <Users size={18} />, title: "Light CRM", body: "Opportunities, tasks, calls, notes and deal values, built around the conversations your campaigns start." },
              { icon: <Bot size={18} />, title: "Agents", body: "A reply agent drafts and sends answers, a lead finder agent keeps campaigns stocked, a deliverability agent watches your health." },
              { icon: <Workflow size={18} />, title: "Automations", body: "When a lead replies, clicks or changes status, move them, notify your team or call a webhook." },
              { icon: <ShieldCheck size={18} />, title: "Deliverability tools", body: "DNS checks, blocklist monitoring, inbox placement tests, bounce protection and ESP matching." },
            ]}
          />
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-16 px-4 py-20 sm:px-6">
        <SectionTitle eyebrow="How it works" title="From a new domain to booked meetings" />
        <ol className="mx-auto mt-12 grid max-w-6xl gap-4 md:grid-cols-5">
          {STEPS.map(([t, b], i) => (
            <li key={t} className="rounded-xl border border-line bg-panel p-5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[13px] font-semibold text-on-brand">{i + 1}</span>
              <h3 className="mt-4 font-semibold">{t}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{b}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="api" className="scroll-mt-16 border-y border-line bg-panel px-4 py-20 sm:px-6">
        <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
          <div>
            <SectionTitle center={false} eyebrow="Built for builders" title="An API for everything the app does" body="Create campaigns, add leads, read replies and manage accounts from your own code. Webhooks push replies, opens, clicks and status changes to your systems." />
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/developers" className={buttonClass("primary")}>
                API reference
              </Link>
              <Link to="/developers#webhooks" className={buttonClass("secondary")}>
                Webhooks
              </Link>
            </div>
          </div>
          <pre className="scroll-thin overflow-x-auto rounded-xl bg-[#0f1020] p-5 font-mono text-[12.5px] leading-relaxed text-[#d4d6f0]">
            {`curl -X POST https://your-host/api/v2/leads \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "campaign": "0198…",
    "email": "jordan@example.com",
    "first_name": "Jordan",
    "company_name": "Example Co"
  }'`}
          </pre>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6">
        <SectionTitle title="Questions" />
        <div className="mt-10">
          <Faq
            items={[
              ["Is there a limit on mailboxes?", "No. Connect as many sending accounts as you need; limits are set per mailbox and per campaign."],
              ["Where does my data live?", "On the server you run it on. Mailbox credentials are encrypted at rest and nothing is shared with other installations."],
              ["Does warmup use real inboxes?", "Warmup exchanges messages between the warmup-enabled mailboxes connected to this installation. The more mailboxes in the pool, the more natural the traffic."],
              ["Where do lead finder results come from?", "From the prospect data you import (CSV) plus any data-provider API keys you configure. A fictional demo dataset is included for trying it out."],
              ["Do the AI features need a key?", "Yes — reply drafting, agents and copilot use your Anthropic API key, set by the instance admin or per workspace."],
            ]}
          />
        </div>
      </section>

      <CtaBand />
    </MarketingLayout>
  );
}
