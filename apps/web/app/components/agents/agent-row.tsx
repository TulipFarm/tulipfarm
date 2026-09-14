import { AutonomyChip } from "~/components/autonomy-chip";
import { AgentAvatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import {
  agentDisplayName,
  builtInAgentDisplayName,
  capabilityFacts,
} from "~/lib/agent-capabilities";
import type { AgentSummary, BuiltInAgentSummary } from "~/lib/agents";
import { ReachBadge } from "./reach-badge";
import { RoutineUsageBadge } from "./routine-usage-badge";

const RUNG_LABEL: Record<BuiltInAgentSummary["rung"], string> = {
  fast: "Fast",
  balanced: "Balanced",
};

type AgentRowProps =
  | {
      kind: "custom";
      agent: AgentSummary;
      headingLevel?: 2 | 3;
      /** Published Routines whose `agent` State points at this Agent. See `routineUsageByAgent`. */
      routineUsageCount?: number;
    }
  | {
      kind: "built-in";
      agent: BuiltInAgentSummary;
      headingLevel?: 2 | 3;
    };

/**
 * One agent in the unified roster, custom or built-in.
 *
 * A roster grows to hundreds, so the layout is a list rather than a card grid: type, reach,
 * authority and the CTA land at the same x on every row, which is what lets a reader compare them
 * by scanning instead of reading. Those columns are therefore fixed-width — sized for their
 * longest value (`approval-required`) so a wide value can never shunt the column out of line —
 * and the description is the single flexible column, because it is the part a scanning reader
 * needs least and the detail page carries in full.
 *
 * A custom row is deliberately not itself a link: it carries both "read about this agent" and
 * "use this agent now", and a link wrapping a button is neither reachable nor announceable. The
 * name is the link, the CTA is the button, and `focus-within:` gives the row back its single-target
 * feel. A built-in row's name is plain text instead — there is no detail page for something a user
 * cannot address or edit, and nothing to start a chat with
 * (`packages/built-in-agents/AGENTS.md`).
 */
export function AgentRow(props: AgentRowProps) {
  const Heading = `h${props.headingLevel ?? 3}` as const;

  if (props.kind === "built-in") {
    const { agent } = props;
    const display = builtInAgentDisplayName(agent.id);

    return (
      <article className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 items-center gap-2.5 sm:w-48 sm:shrink-0 lg:w-56">
          <AgentAvatar identity={`built-in-agent:${agent.id}`} className="shrink-0" />
          <Heading className="truncate text-sm font-medium leading-tight text-foreground">
            {display}
          </Heading>
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-muted-foreground">{agent.purpose}</p>
        </div>

        <div className="sm:w-24 sm:shrink-0">
          <Badge variant="info" caps>
            Built-in
          </Badge>
        </div>

        <div className="sm:w-28 sm:shrink-0" />

        <div className="sm:w-40 sm:shrink-0">
          <span className="text-[11px] text-muted-foreground">{RUNG_LABEL[agent.rung]}</span>
        </div>
      </article>
    );
  }

  const { agent, routineUsageCount = 0 } = props;
  const display = agentDisplayName(agent);
  const facts = capabilityFacts(agent.capabilityRestrictions);
  const context = [agent.domain, ...facts.resourceTypes].filter(Boolean);

  return (
    <article className="flex flex-col gap-2 px-3 py-2.5 transition-colors focus-within:bg-muted/50 hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5 sm:w-48 sm:shrink-0 lg:w-56">
        <AgentAvatar identity={agent.name} className="shrink-0" />
        <Heading className="min-w-0 truncate text-sm font-medium leading-tight text-foreground">
          <Link
            to={`/agents/${encodeURIComponent(agent.name)}`}
            className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {display}
          </Link>
        </Heading>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted-foreground">
          {agent.description ?? "No description written."}
        </p>
        {context.length > 0 ? (
          <p className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
            {context.join(" · ")}
          </p>
        ) : null}
        {routineUsageCount > 0 ? (
          <p className="mt-1">
            <RoutineUsageBadge count={routineUsageCount} />
          </p>
        ) : null}
      </div>

      <div className="sm:w-24 sm:shrink-0">
        <Badge variant="primary" caps>
          Custom
        </Badge>
      </div>

      <div className="sm:w-28 sm:shrink-0">
        <ReachBadge reach={facts.reach} />
      </div>

      <div className="sm:w-40 sm:shrink-0">
        {agent.autonomy ? (
          <AutonomyChip autonomy={agent.autonomy} size="xs" className="text-[10px]" />
        ) : null}
      </div>

      <Button asChild size="sm" variant="outline" className="shrink-0">
        <Link
          to={`/?agent=${encodeURIComponent(agent.name)}`}
          aria-label={`Start a chat with ${display}`}
        >
          Start a chat
        </Link>
      </Button>
    </article>
  );
}
