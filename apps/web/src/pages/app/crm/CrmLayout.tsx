// /app/crm/* — the CRM header: section tabs, the "New" menu and a link to calling settings.
import { CalendarPlus, CheckSquare, ChevronDown, MessageSquare, Phone, Plus, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { cn } from "@/lib/cn";
import { useCan } from "@/lib/session";
import { Button, ButtonLink, CountPill, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui";
import { revealSideways, useScrollFade } from "@/components/ui/scroll-x";
import { CallDialog, MeetingDialog, SmsDialog, TaskDialog, useCrmCounts } from "./shared";

const INBOX_PATHS = /^\/app\/crm(\/(emails|calls|sms|tasks|upcoming|archive)(\/.*)?)?\/?$/;

const TABS: Array<{ to: string; label: string; match?: RegExp }> = [
  { to: "/app/crm", label: "Inbox", match: INBOX_PATHS },
  { to: "/app/crm/opportunities", label: "Opportunities" },
  { to: "/app/crm/leads", label: "Leads", match: /^\/app\/crm\/leads/ },
  { to: "/app/crm/dynamic-views", label: "Salesflows" },
  { to: "/app/crm/reports", label: "Reports" },
  { to: "/app/crm/activity-comparison", label: "Activity comparison" },
];

/** Adds a task, meeting, call or text from anywhere in the CRM. */
export function NewMenu({ leadEmail, phone, size = "sm" }: { leadEmail?: string | null; phone?: string | null; size?: "sm" | "xs" }) {
  const [open, setOpen] = useState<"task" | "meeting" | "call" | "sms" | null>(null);
  const close = (v: boolean) => !v && setOpen(null);
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button size={size} variant="primary" icon={<Plus size={14} />}>
            New <ChevronDown size={13} className="-mr-1 opacity-80" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<CheckSquare size={14} />} onSelect={() => setOpen("task")}>
            Task
          </MenuItem>
          <MenuItem icon={<CalendarPlus size={14} />} onSelect={() => setOpen("meeting")}>
            Meeting
          </MenuItem>
          <MenuItem icon={<Phone size={14} />} onSelect={() => setOpen("call")}>
            Call
          </MenuItem>
          <MenuItem icon={<MessageSquare size={14} />} onSelect={() => setOpen("sms")}>
            SMS
          </MenuItem>
        </MenuContent>
      </Menu>
      <TaskDialog open={open === "task"} onOpenChange={close} leadEmail={leadEmail} />
      <MeetingDialog open={open === "meeting"} onOpenChange={close} leadEmail={leadEmail} />
      <CallDialog open={open === "call"} onOpenChange={close} leadEmail={leadEmail} phone={phone} />
      <SmsDialog open={open === "sms"} onOpenChange={close} leadEmail={leadEmail} phone={phone} />
    </>
  );
}

export default function CrmLayout() {
  const { pathname } = useLocation();
  const [tabsRef, tabsFade] = useScrollFade<HTMLElement>();
  useEffect(() => revealSideways(tabsRef.current, tabsRef.current?.querySelector("[data-active]")), [pathname, tabsRef]);
  const can = useCan();
  const counts = useCrmCounts();
  const active = (t: (typeof TABS)[number]) => (t.match ? t.match.test(pathname) : pathname === t.to || pathname.startsWith(`${t.to}/`));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line bg-panel px-4 sm:px-6">
        <div className="flex items-center justify-between gap-3 pt-3">
          <h1 className="text-lg font-semibold tracking-tight">CRM</h1>
          <div className="flex items-center gap-1.5">
            {can.write && <NewMenu />}
            <ButtonLink to="/app/crm/calls-and-sms" size="sm" variant="ghost" icon={<Settings size={14} />} aria-label="CRM settings">
              <span className="hidden sm:inline">Settings</span>
            </ButtonLink>
          </div>
        </div>
        <nav ref={tabsRef} style={tabsFade} className="scroll-none -mb-px mt-1 flex gap-5 overflow-x-auto overflow-y-hidden" aria-label="CRM sections">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              data-active={active(t) || undefined}
              className={cn(
                "relative inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-1 text-[13px] font-medium transition-colors",
                active(t) ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
              )}
            >
              {t.label}
              {t.to === "/app/crm" && <CountPill n={counts.data?.inbox.all} />}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
