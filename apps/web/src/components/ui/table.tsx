import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { ErrorState } from "./misc";
import { ScrollX } from "./scroll-x";
import { Checkbox } from "./toggle";
import { SkeletonRows } from "./spinner";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
  sortable?: boolean;
  /** Hide below this breakpoint. */
  hideBelow?: "sm" | "md" | "lg" | "xl";
}

const hide = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell", xl: "hidden xl:table-cell" };

export interface Selection {
  ids: Set<string>;
  /** Every row matching the current filter, including unloaded pages. */
  all: boolean;
}

export const emptySelection = (): Selection => ({ ids: new Set(), all: false });

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  empty,
  error,
  onRetry,
  onRowClick,
  selection,
  onSelectionChange,
  sort,
  onSortChange,
  hasMore,
  onLoadMore,
  loadingMore,
  className,
  dense,
  rowClassName,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  /** The request for the rows failed: shown instead of `empty`, so a failed list doesn't look empty. */
  error?: unknown;
  onRetry?: () => unknown;
  onRowClick?: (row: T) => void;
  selection?: Selection;
  onSelectionChange?: (s: Selection) => void;
  sort?: { key: string; dir: "asc" | "desc" };
  onSortChange?: (s: { key: string; dir: "asc" | "desc" }) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  className?: string;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
}) {
  const selectable = !!selection && !!onSelectionChange;
  const allLoadedSelected = selectable && rows.length > 0 && rows.every((r) => selection!.ids.has(rowKey(r)));
  const someSelected = selectable && (selection!.all || selection!.ids.size > 0);
  const toggleAll = () => {
    if (!selectable) return;
    if (allLoadedSelected || selection!.all) onSelectionChange!(emptySelection());
    else onSelectionChange!({ ids: new Set(rows.map(rowKey)), all: false });
  };
  const toggle = (id: string) => {
    if (!selectable) return;
    const ids = new Set(selection!.ids);
    if (selection!.all) {
      // Leaving "all" mode: keep the loaded rows minus this one.
      rows.forEach((r) => ids.add(rowKey(r)));
      ids.delete(id);
      onSelectionChange!({ ids, all: false });
      return;
    }
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    onSelectionChange!({ ids, all: false });
  };
  const cellPad = dense ? "px-3 py-2" : "px-4 py-3";
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-panel shadow-card", className)}>
      <ScrollX>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-panel-2/60 text-left text-xs font-medium text-muted">
              {selectable && (
                <th className="w-10 px-4 py-2.5">
                  <Checkbox aria-label="Select all" checked={selection!.all || allLoadedSelected ? true : someSelected ? "indeterminate" : false} onChange={toggleAll} />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} className={cn(dense ? "px-3 py-2" : "px-4 py-2.5", "whitespace-nowrap font-medium", c.hideBelow && hide[c.hideBelow], c.headerClassName)}>
                    {c.sortable && onSortChange ? (
                      <button
                        type="button"
                        className={cn("-my-1 inline-flex items-center gap-1 py-1 hover:text-text", active && "text-text")}
                        onClick={() => onSortChange({ key: c.key, dir: active && sort!.dir === "desc" ? "asc" : "desc" })}
                      >
                        {c.header}
                        {active && (sort!.dir === "desc" ? <ChevronDown size={13} /> : <ChevronUp size={13} />)}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!loading &&
              rows.map((row) => {
                const id = rowKey(row);
                const checked = selectable && (selection!.all || selection!.ids.has(id));
                return (
                  <tr
                    key={id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      "border-b border-line last:border-0",
                      onRowClick && "cursor-pointer hover:bg-panel-2/60",
                      checked && "bg-brand-soft/40",
                      rowClassName?.(row),
                    )}
                  >
                    {selectable && (
                      <td className="w-10 px-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox aria-label="Select row" checked={!!checked} onChange={() => toggle(id)} />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} className={cn(cellPad, "align-middle", c.hideBelow && hide[c.hideBelow], c.className)}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </ScrollX>
      {loading && <SkeletonRows rows={6} />}
      {!loading &&
        rows.length === 0 &&
        (error ? <ErrorState title="Couldn't load this list" error={error} onRetry={onRetry} /> : (empty ?? <p className="px-4 py-12 text-center text-[13px] text-muted">Nothing here yet.</p>))}
      {!loading && hasMore && onLoadMore && (
        <div className="flex justify-center border-t border-line p-3">
          <Button size="sm" variant="ghost" loading={loadingMore} onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

/** Banner shown above a table when rows are selected. */
export function SelectionBar({
  count,
  total,
  allSelected,
  onSelectAll,
  onClear,
  children,
}: {
  count: number;
  total?: number;
  allSelected?: boolean;
  onSelectAll?: () => void;
  onClear: () => void;
  children: ReactNode;
}) {
  if (!count && !allSelected) return null;
  return (
    <div className="animate-in mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-[13px]">
      <span className="font-medium text-brand-text">{allSelected ? (total !== undefined ? `All ${total.toLocaleString()} selected` : "All selected") : `${count.toLocaleString()} selected`}</span>
      {!allSelected && onSelectAll && total !== undefined && total > count && (
        <button type="button" className="text-brand-text underline underline-offset-2" onClick={onSelectAll}>
          Select all {total.toLocaleString()}
        </button>
      )}
      <button type="button" className="text-muted hover:text-text" onClick={onClear}>
        Clear
      </button>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
