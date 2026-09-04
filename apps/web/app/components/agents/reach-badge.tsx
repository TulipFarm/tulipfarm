import { Badge } from "~/components/ui/badge";
import type { Reach } from "~/lib/agent-capabilities";
import { REACH_LABEL } from "~/lib/agent-capabilities";

/**
 * Whether an agent can change anything, as its own chip.
 *
 * Autonomy answers "how much rope", which is an ordered scale and takes the `heat-*` ramp. Reach
 * answers a different, unordered question — "does it write" — so it takes a `status-*` tone
 * instead: an agent whose limits were never declared genuinely is the cautionary case.
 *
 * `read-only` is the neutral end rather than a green one. It is the safe answer, but a roster is
 * mostly safe answers, so colouring it put a badge on every row that had earned no attention. The
 * hue marks the exception; the word carries the fact on its own.
 */
export function ReachBadge({ reach }: { reach: Reach }) {
  const variant = reach === "read-only" ? "neutral" : reach === "changes-data" ? "info" : "warning";

  return <Badge variant={variant}>{REACH_LABEL[reach]}</Badge>;
}
