import { Link } from "@remix-run/react";
import { StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { RoutineSummary, RunStatus } from "~/lib/routines";
import {
  type RunHealth,
  riskLabel,
  riskShortLabel,
  riskTone,
  routineDisplayName,
} from "~/lib/routines/facts";
import { EffectSummary, RoutineLink } from "./effect-summary";
import { TriggerList } from "./trigger-chip";

const HEALTH: Record<
  RunHealth,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  healthy: { label: "Last run fine", tone: "success" },
  attention: { label: "Needs attention", tone: "warning" },
  failing: { label: "Last run failed", tone: "danger" },
  "never-run": { label: "Never run", tone: "neutral" },
};

export interface RoutineRowProps {
  routine: RoutineSummary;
  health: RunHealth;
  latest?: { id: string; status: RunStatus; createdAt: string };
  /** 2 in an ungrouped list, 3 under a group's `h2`, so the outline never skips a level. */
  headingLevel?: 2 | 3;
}

/**
 * One Routine in the catalog, as a row.
 *
 * A list rather than a card grid, for the same reason the agent roster is: an instance grows to
 * hundreds of Routines, and health, reach and the CTA landing at the same x on every row is what
 * lets a reader compare them by scanning. Those columns are fixed-width — sized for their longest
 * value — so one wide value can never shunt a column out of line, and the trigger column is the
 * single flexible one because it is the part that varies most and matters most.
 *
 * The row is deliberately not itself a link: it carries both "read about this" and "run this now",
 * and a link wrapping a button is neither reachable nor announceable.
 */
export function RoutineRow({ routine, health, latest, headingLevel = 3 }: RoutineRowProps) {
  const display = routineDisplayName(routine);
  const { summary } = routine;
  const Heading = `h${headingLevel}` as const;
  const status = HEALTH[health];

  return (
    <article className="flex flex-col gap-2 px-3 py-2.5 transition-colors focus-within:bg-muted/50 hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 sm:w-56 sm:shrink-0 lg:w-64">
        <Heading className="truncate text-sm font-medium leading-tight text-foreground">
          <RoutineLink slug={routine.slug}>{display}</RoutineLink>
        </Heading>
        <p className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {/* A routine with no display name is already titled by its slug; printing it twice
              spends the only descriptive line in the row saying nothing. */}
          {display === routine.slug ? "" : `${routine.slug} · `}v{routine.authoredVersion}
          {summary.owner ? ` · ${summary.owner}` : ""}
        </p>
      </div>

      <div className="min-w-0 flex-1">
        <TriggerList triggers={routine.triggers} />
        <p className="mt-1 truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {summary.stateCount} {summary.stateCount === 1 ? "step" : "steps"}
          {summary.requiresApproval ? " · needs approval" : ""}
          {summary.concurrencyPolicy ? ` · ${summary.concurrencyPolicy.replaceAll("_", " ")}` : ""}
        </p>
      </div>

      <div className="sm:w-24 sm:shrink-0">
        <EffectSummary effects={summary.effects} />
      </div>

      <div className="sm:w-32 sm:shrink-0">
        <Badge variant={riskTone(summary.maxRiskClass)} title={riskLabel(summary.maxRiskClass)}>
          {riskShortLabel(summary.maxRiskClass)}
        </Badge>
      </div>

      <div className="sm:w-36 sm:shrink-0">
        {latest ? (
          <Link
            to={`/runs/${latest.id}`}
            className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label={`${status.label}, open the newest run of ${display}`}
          >
            <StatusBadge label={status.label} tone={status.tone} />
          </Link>
        ) : (
          <StatusBadge label={status.label} tone={status.tone} />
        )}
      </div>

      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link to={`/routines/${encodeURIComponent(routine.slug)}`} aria-label={`Open ${display}`}>
          Open
        </Link>
      </Button>
    </article>
  );
}
