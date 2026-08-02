import { StatusBadge, type StatusTone } from "~/components/status-badge";
import type { RunStatus } from "~/lib/routines";

const STATUS_TONE: Record<RunStatus, StatusTone> = {
  pending: "neutral",
  running: "info",
  sleeping: "neutral",
  waiting_approval: "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <StatusBadge label={status.replace("_", " ")} tone={STATUS_TONE[status]} />;
}
