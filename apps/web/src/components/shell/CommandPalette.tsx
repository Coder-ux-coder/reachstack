import { Command, defaultFilter } from "cmdk";
import * as RD from "@radix-ui/react-dialog";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Mail, Plus, Search, Send, UserPlus, UserRound } from "lucide-react";
import { get, type Page } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";
import { moduleOn, useCan, useSession } from "@/lib/session";
import { moduleForPath, NAV, SETTINGS_ITEM } from "./nav";

interface Person {
  email: string;
  name: string | null;
  company_name: string | null;
  threads: number;
}

const uniboxSearch = (search: string) => `/app/unibox?search=${encodeURIComponent(search)}`;

/**
 * Unibox items are matched by the server (name, address or company) and follow the typed text, so they always count
 * as a match, "Find" first. cmdk only re-reads an item's keywords when its value changes, so fuzzy matching them
 * would go stale.
 */
const UNIBOX_FIND = "unibox:find";
const UNIBOX_PERSON = "unibox:person:";
const filter = (value: string, search: string, keywords?: string[]) =>
  value === UNIBOX_FIND ? 0.9 : value.startsWith(UNIBOX_PERSON) ? 0.89 : defaultFilter(value, search, keywords);

const SETTINGS_PAGES = [
  ["/app/settings/account", "Account & security"],
  ["/app/settings/preferences", "Workspace preferences"],
  ["/app/settings/integrations", "Integrations & API keys"],
  ["/app/settings/billing", "Billing & plans"],
  ["/app/settings/blocklist", "Blocklist"],
  ["/app/settings/advanced-deliverability", "Advanced deliverability"],
  ["/app/settings/lead-labels", "Lead labels"],
  ["/app/settings/custom-variables", "Custom variables"],
  ["/app/settings/recently-deleted", "Recently deleted"],
  ["/app/crm/workspace-and-members", "Team members"],
] as const;

/** The palette's own pages and actions, to tell a page ("camp") from a person ("kim") when placing the Unibox group. */
const PAGE_LABELS = [
  "New campaign",
  "Connect an email account",
  "Find leads",
  "Invite a teammate",
  ...[...NAV.flatMap((g) => g.items), SETTINGS_ITEM].map((it) => it.label),
  ...SETTINGS_PAGES.map(([, label]) => label),
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const nav = useNavigate();
  const can = useCan();
  const me = useSession();
  // Product areas the owner switched off don't show up here either.
  const areaOn = (to: string) => moduleOn(me, moduleForPath(to) ?? undefined);
  const [q, setQ] = useState("");
  const campaigns = useQuery({
    queryKey: ["campaigns", "palette", q],
    queryFn: () => get<Page<{ id: string; name: string }>>("/api/v2/campaigns", { search: q, limit: 6 }),
    enabled: open && q.trim().length > 1 && can.perm("view_campaigns"),
  });
  // Find a person: everyone the workspace has conversations with, by address, name or company.
  const term = q.trim();
  const findPeople = open && term.length > 1 && can.perm("unibox");
  const personTerm = useDebounced(term, 200);
  const people = useQuery({
    queryKey: ["unibox-people", personTerm],
    queryFn: () => get<{ items: Person[] }>("/api/app/unibox/people", { q: personTerm, limit: 6 }),
    enabled: findPeople && personTerm.length > 1,
    staleTime: 30_000,
  });
  // cmdk shows groups in the order they're written (its group sorting doesn't work), so the Unibox group leads unless
  // a page, action or campaign starts with the text; then Enter still opens that page, as before.
  const pageFirst = findPeople && [...PAGE_LABELS, ...(campaigns.data?.items.map((c) => c.name) ?? [])].some((label) => defaultFilter(label, term) >= 0.8);
  const go = (to: string) => {
    onOpenChange(false);
    setQ("");
    nav(to);
  };
  const item = "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm aria-selected:bg-panel-2";
  const group = "px-1 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint";
  const unibox = findPeople && (
    <Command.Group heading="Unibox" className={group}>
      <Command.Item value={UNIBOX_FIND} className={item} onSelect={() => go(uniboxSearch(term))}>
        <Inbox size={15} className="shrink-0 text-muted" />
        <span className="min-w-0 truncate">Find “{term}” in the inbox</span>
      </Command.Item>
      {personTerm === term &&
        people.data?.items.map((p) => (
          <Command.Item key={p.email} value={UNIBOX_PERSON + p.email} className={item} onSelect={() => go(uniboxSearch(`lead:${p.email}`))}>
            <UserRound size={15} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              {p.name || p.email}
              <span className="ml-2 text-xs text-muted">{[p.name ? p.email : null, p.company_name].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="shrink-0 text-xs text-faint">
              {p.threads} {p.threads === 1 ? "conversation" : "conversations"}
            </span>
          </Command.Item>
        ))}
    </Command.Group>
  );
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <RD.Content className="animate-in fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
          <RD.Title className="sr-only">Command menu</RD.Title>
          <RD.Description className="sr-only">Search pages and actions</RD.Description>
          <Command label="Command menu" shouldFilter filter={filter}>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={16} className="text-faint" />
              <Command.Input value={q} onValueChange={setQ} placeholder="Search pages, campaigns and actions…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
            </div>
            <Command.List className="scroll-thin max-h-[60vh] overflow-y-auto py-2">
              <Command.Empty className="px-4 py-8 text-center text-sm text-muted">No results.</Command.Empty>
              {!pageFirst && unibox}
              <Command.Group heading="Actions" className={group}>
                {can.perm("edit_campaigns") && (
                  <Command.Item className={item} onSelect={() => go("/app/campaign/create")}>
                    <Plus size={15} className="text-muted" /> New campaign
                  </Command.Item>
                )}
                {can.perm("accounts") && can.write && (
                  <Command.Item className={item} onSelect={() => go("/app/account/connect")}>
                    <Mail size={15} className="text-muted" /> Connect an email account
                  </Command.Item>
                )}
                {can.perm("lead_finder") && areaOn("/app/lead-finder") && (
                  <Command.Item className={item} onSelect={() => go("/app/lead-finder")}>
                    <Search size={15} className="text-muted" /> Find leads
                  </Command.Item>
                )}
                {can.admin && (
                  <Command.Item className={item} onSelect={() => go("/app/crm/workspace-and-members?invite=1")}>
                    <UserPlus size={15} className="text-muted" /> Invite a teammate
                  </Command.Item>
                )}
              </Command.Group>
              {!!campaigns.data?.items.length && (
                <Command.Group heading="Campaigns" className={group}>
                  {campaigns.data.items.map((c) => (
                    <Command.Item key={c.id} value={`campaign ${c.name} ${c.id}`} className={item} onSelect={() => go(`/app/campaign/${c.id}/analytics`)}>
                      <Send size={15} className="text-muted" /> {c.name}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              <Command.Group heading="Go to" className={group}>
                {[...NAV.flatMap((g) => g.items), SETTINGS_ITEM]
                  .filter((it) => (!it.perm || can.perm(it.perm)) && areaOn(it.to))
                  .map((it) => (
                    <Command.Item key={it.to} className={item} onSelect={() => go(it.to)}>
                      <it.icon size={15} className="text-muted" /> {it.label}
                    </Command.Item>
                  ))}
              </Command.Group>
              <Command.Group heading="Settings" className={group}>
                {SETTINGS_PAGES.filter(([to]) => areaOn(to)).map(([to, label]) => (
                  <Command.Item key={to} className={item} onSelect={() => go(to)}>
                    {label}
                  </Command.Item>
                ))}
              </Command.Group>
              {pageFirst && unibox}
            </Command.List>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
