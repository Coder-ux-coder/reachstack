import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  return <Loader2 aria-hidden size={size} className={cn("animate-spin text-muted", className)} />;
}

export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div role="status" className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 text-muted">
      <Spinner size={22} />
      {label && <p className="text-sm">{label}</p>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-panel-2", className)} />;
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
