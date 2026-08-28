import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Clock,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import { StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import type { ActivityEntry } from "~/lib/activity-feed";
import { entryStatusLabel } from "./presentation";

/*
 * A Run's status is the state of an execution step, which DESIGN.md §4.3 puts on the closed
 * `run-*` axis. Borrowing `status-*` for it would say a content lifecycle state instead, so Runs
 * get their own badge and only log entries go through StatusBadge.
 *
 * Only a state worth stopping on wears a filled pill. In a healthy instance nearly every row
 * succeeds, so filling those too puts saturated colour where nothing varies and leaves a real
 * problem with nothing to stand out against.
 */

type RunTone = "pending" | "active" | "ok" | "error" | "blocked" | "skipped";

const RUN_TONES: Record<string, RunTone> = {
  queued: "pending",
  claimed: "pending",
  running: "active",
  waiting: "blocked",
  succeeded: "ok",
  cancelling: "blocked",
  cancelled: "skipped",
  failed: "error",
  attention_required: "blocked",
  needs_reconciliation: "blocked",
};

/*
 * `run-pending` and `run-skipped` are dot colours. Against `run-surface` they measure 4.44:1 and
 * 2.92:1 in dark, 3.78:1 and 2.76:1 in light, all under the 4.5:1 floor this 12px label needs.
 * The neutral pair reads the same "nothing is happening here" and measures 7.16:1.
 */
const TONE_CLASS: Record<Exclude<RunTone, "ok">, string> = {
  pending: "border-border bg-muted text-muted-foreground",
  active: "border-run-active/30 bg-run-active/10 text-run-active",
  error: "border-run-error/30 bg-run-error/10 text-run-error",
  blocked: "border-run-blocked/30 bg-run-blocked/10 text-run-blocked",
  skipped: "border-border bg-muted text-muted-foreground",
};

const TONE_ICON = {
  pending: Clock,
  active: CircleDot,
  error: CircleAlert,
  blocked: TriangleAlert,
  skipped: CircleSlash,
} satisfies Record<Exclude<RunTone, "ok">, LucideIcon>;

/** Success, drawn flat: same icon, same word, without the fill that would make it compete. */
function Settled({ label }: { label: string }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 px-1.5 text-xs font-medium text-muted-foreground">
      <CircleCheck className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/** The one badge the timeline and the detail panel both use, on whichever axis the entry belongs to. */
export function EntryBadge({ entry }: { entry: ActivityEntry }) {
  const label = entryStatusLabel(entry);
  if (entry.kind === "log") {
    if (entry.status === "error") return <StatusBadge label={label} tone="danger" />;
    return <Settled label={label} />;
  }
  const tone = RUN_TONES[entry.status] ?? "pending";
  if (tone === "ok") return <Settled label={label} />;
  const Icon = TONE_ICON[tone];
  return (
    <Badge className={TONE_CLASS[tone]}>
      <Icon className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}
