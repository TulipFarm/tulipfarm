import type { RunStatus } from "~/lib/routines";
import { cn } from "~/lib/utils";

const STATUS_STYLES: Record<RunStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-primary/10 text-primary",
  sleeping: "bg-muted text-muted-foreground",
  waiting_approval: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  succeeded: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground line-through",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 text-xs uppercase tracking-[0.15em]",
        STATUS_STYLES[status] ?? "bg-muted text-muted-foreground"
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}
