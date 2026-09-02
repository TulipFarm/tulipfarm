import { AgentGlyph } from "~/components/agent-glyph";
import { AutonomyChip } from "~/components/autonomy-chip";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { agentDisplayName, capabilityFacts } from "~/lib/agent-capabilities";
import type { AgentSummary } from "~/lib/agents";
import { ReachBadge } from "./reach-badge";

/**
 * One agent in the roster, as a row.
 *
 * A roster grows to hundreds, so the layout is a list rather than a card grid: reach, authority and
 * the CTA land at the same x on every row, which is what lets a reader compare them by scanning
 * instead of reading. Those columns are therefore fixed-width — sized for their longest value
 * (`approval-required`) so a wide value can never shunt the column out of line — and the
 * description is the single flexible column, because it is the part a scanning reader needs least
 * and the detail page carries in full.
 *
 * The row is deliberately not itself a link: it carries both "read about this agent" and "use this
 * agent now", and a link wrapping a button is neither reachable nor announceable. The name is the
 * link, the CTA is the button, and `focus-within:` gives the row back its single-target feel.
 */
export function AgentRow({
  agent,
  headingLevel = 3,
}: {
  agent: AgentSummary;
  /** 2 in an ungrouped list, 3 under a domain's `h2`, so the outline never skips a level. */
  headingLevel?: 2 | 3;
}) {
  const display = agentDisplayName(agent);
  const facts = capabilityFacts(agent.capabilityRestrictions);
  const context = [agent.domain, ...facts.resourceTypes].filter(Boolean);
  const Heading = `h${headingLevel}` as const;

  return (
    <article className="flex flex-col gap-2 px-3 py-2.5 transition-colors focus-within:bg-muted/50 hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5 sm:w-48 sm:shrink-0 lg:w-56">
        <AgentGlyph
          name={agent.name}
          domain={agent.domain}
          autonomy={agent.autonomy}
          size="sm"
          decorative
          className="shrink-0"
        />
        <div className="min-w-0">
          <Heading className="truncate text-sm font-medium leading-tight text-foreground">
            <Link
              to={`/agents/${encodeURIComponent(agent.name)}`}
              className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {display}
            </Link>
          </Heading>
          <p className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
            {agent.name}
          </p>
        </div>
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
