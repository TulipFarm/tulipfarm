import { PlanTrace } from "./plan-trace";
import type { PlannedRound } from "./timeline-groups";

/** Pins the in-progress plan beside the transcript, so it stays visible while the Turn runs. */
export function PlanSidebar({
  rounds,
  pending,
}: {
  rounds: readonly PlannedRound[];
  pending: boolean;
}) {
  return (
    <aside
      aria-label="Plan progress"
      className="hidden w-72 shrink-0 flex-col overflow-y-auto border-r border-border px-3 py-3 md:flex"
    >
      <PlanTrace rounds={rounds} pending={pending} />
    </aside>
  );
}
