import { Fragment } from "react";
import { Dialog, Kbd } from "@/components/ui";

/** Every Unibox key, as the "?" sheet lists them. The handlers live in Unibox.tsx (list) and ThreadView.tsx (conversation). */
const GROUPS: Array<{ title: string; keys: Array<[keys: string[], what: string]> }> = [
  {
    title: "Move around",
    keys: [
      [["j"], "Next conversation"],
      [["k"], "Previous conversation"],
      [["n"], "Next unread conversation"],
      [["/"], "Search all mail"],
      [["Esc"], "Close the conversation"],
    ],
  },
  {
    title: "Open conversation",
    keys: [
      [["r"], "Reply"],
      [["a"], "Reply all"],
      [["f"], "Forward"],
      [["e"], "Mark as done, or move it back to the inbox"],
      [["1", "9"], "Apply a label (numbered in the label menu)"],
    ],
  },
  {
    title: "Anywhere",
    keys: [
      [["c"], "Write a new email"],
      [["?"], "Show these shortcuts"],
      [["Ctrl", "K"], "Find a person, page or campaign"],
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title="Keyboard shortcuts" description="Keys work when you're not typing in a field.">
      <div className="space-y-4">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{g.title}</h3>
            <dl className="space-y-1">
              {g.keys.map(([keys, what]) => (
                <div key={what} className="flex items-center justify-between gap-3 text-[13px]">
                  <dt className="min-w-0 text-muted">{what}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {keys.map((k, i) => (
                      <Fragment key={k}>
                        {i > 0 && <span className="text-xs text-faint">{keys[0] === "1" ? "to" : "+"}</span>}
                        <Kbd>{k}</Kbd>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
