import { StatusBadge, type StatusTone } from "~/components/status-badge";
import type { RunStatus } from "~/lib/routines";

const STATUS_TONE: Record<RunStatus, StatusTone> = {
  queued: "neutral",
  claimed: "neutral",
  running: "info",
  waiting: "warning",
  succeeded: "success",
  failed: "danger",
  cancelling: "warning",
  cancelled: "neutral",
  attention_required: "warning",
  needs_reconciliation: "danger",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <StatusBadge label={status.replace(/_/g, " ")} tone={STATUS_TONE[status]} />;
}
