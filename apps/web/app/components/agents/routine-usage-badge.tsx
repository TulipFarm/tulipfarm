import { Badge } from "~/components/ui/badge";

/**
 * How many published Routines point an `agent` State at this Agent — the cross-reference a reader
 * needs before they touch its instructions or limits, since a Routine keeps running against
 * whatever the Agent becomes. Renders nothing at zero: an unused Agent is the common case, not a
 * fact worth a badge on every other row.
 */
export function RoutineUsageBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge variant="info">
      Used by {count} {count === 1 ? "routine" : "routines"}
    </Badge>
  );
}
