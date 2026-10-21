import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { format, parseISO } from "date-fns";

export const SERIES_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

export interface Series {
  key: string;
  label: string;
  color?: string;
}

const axis = { stroke: "var(--faint)", fontSize: 11, tickLine: false, axisLine: false } as const;

function DateTick(v: string) {
  try {
    return format(parseISO(v), "MMM d");
  } catch {
    return v;
  }
}

/** Legend names in the muted text colour (the dot shows the series colour): series colours are too light to read as text. */
const legendText = (value: string) => <span style={{ color: "var(--muted)" }}>{value}</span>;

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium">{label ? DateTick(label) : ""}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{p.name}</span>
          <span className="ml-auto pl-4 font-medium tabular-nums">{p.value.toLocaleString()}</span>
        </p>
      ))}
    </div>
  );
}

/** Daily trend lines over `date` keyed rows. */
export function TrendChart({ data, series, height = 260, xKey = "date", stacked }: { data: object[]; series: Series[]; height?: number; xKey?: string; stacked?: boolean }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.25} />
                <stop offset="100%" stopColor={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey={xKey} tickFormatter={DateTick} {...axis} minTickGap={24} />
          <YAxis allowDecimals={false} {...axis} />
          <Tooltip content={<ChartTooltip />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} formatter={legendText} />
          {series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? "1" : undefined}
              stroke={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              fill={`url(#g-${s.key})`}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BarsChart({ data, series, height = 240, xKey = "date", stacked, horizontal }: { data: object[]; series: Series[]; height?: number; xKey?: string; stacked?: boolean; horizontal?: boolean }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 8, right: 8, left: horizontal ? 8 : -18, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={!!horizontal} horizontal={!horizontal} />
          {/* No fragments here: recharts 2 finds its axes among direct children, and can't see inside a React 19 fragment. */}
          {horizontal ? <XAxis type="number" allowDecimals={false} {...axis} /> : <XAxis dataKey={xKey} tickFormatter={xKey === "date" ? DateTick : undefined} {...axis} minTickGap={16} />}
          {horizontal ? <YAxis type="category" dataKey={xKey} width={110} {...axis} /> : <YAxis allowDecimals={false} {...axis} />}
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--panel-2)" }} />
          {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} formatter={legendText} />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? "1" : undefined} fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} radius={stacked ? 0 : [4, 4, 0, 0]} maxBarSize={36} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
