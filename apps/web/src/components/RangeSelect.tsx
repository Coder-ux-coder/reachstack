import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { RANGE_OPTIONS, resolveRange, todayIn, type DateRange, type RangeKey } from "@/lib/dates";
import { useWorkspaceZone } from "@/lib/session";
import { Button, Input, Popover, Select } from "@/components/ui";

/** Date range dropdown used by analytics screens; "Custom range" opens a from/to picker. */
export function RangeSelect({ value, onChange, className }: { value: DateRange; onChange: (r: DateRange) => void; className?: string }) {
  const [from, setFrom] = useState(value.start_date ?? "");
  const [to, setTo] = useState(value.end_date ?? "");
  const [open, setOpen] = useState(false);
  const zone = useWorkspaceZone();
  return (
    <div className="flex items-center gap-2">
      <Select
        size="sm"
        className={className ?? "w-40"}
        value={value.key}
        aria-label="Date range"
        onChange={(k: RangeKey) => {
          if (k === "custom") setOpen(true);
          else onChange(resolveRange(k, undefined, zone));
        }}
        options={RANGE_OPTIONS}
      />
      {value.key === "custom" || open ? (
        <Popover
          open={open}
          onOpenChange={setOpen}
          className="w-72 p-3"
          trigger={
            <Button size="sm" icon={<CalendarDays size={14} />}>
              {value.key === "custom" && value.start_date ? `${value.start_date} → ${value.end_date ?? "today"}` : "Pick dates"}
            </Button>
          }
        >
          <div className="space-y-2">
            <label className="block text-xs text-muted">
              From
              <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="mt-1" />
            </label>
            <label className="block text-xs text-muted">
              To
              <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="mt-1" />
            </label>
            <Button
              size="sm"
              variant="primary"
              className="w-full"
              disabled={!from}
              onClick={() => {
                onChange(resolveRange("custom", { start_date: from, end_date: to || todayIn(zone) }));
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
