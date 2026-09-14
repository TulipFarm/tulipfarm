import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { builtInAgentDisplayName } from "~/lib/agent-capabilities";
import type { BuiltInAgentSummary } from "~/lib/agents";

const RUNG_LABEL: Record<BuiltInAgentSummary["rung"], string> = {
  fast: "Fast",
  balanced: "Balanced",
};

/**
 * One platform agent in the roster: a runtime-owned single-shot prompt with no persona, no Soul
 * entry, and nobody to start a chat with (`packages/built-in-agents/AGENTS.md`). Unlike `AgentRow`
 * its name is plain text rather than a link — there is no detail page for something a user cannot
 * address or edit — and it carries a "Built-in" badge instead of a reach/authority pair, since
 * neither concept applies to a call the runtime makes on its own behalf.
 */
export function BuiltInAgentRow({
  agent,
  headingLevel = 3,
}: {
  agent: BuiltInAgentSummary;
  headingLevel?: 2 | 3;
}) {
  const display = builtInAgentDisplayName(agent.id);
  const Heading = `h${headingLevel}` as const;

  return (
    <article className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5 sm:w-48 sm:shrink-0 lg:w-56">
        <Avatar identity={`built-in-agent:${agent.id}`} className="shrink-0" />
        <div className="min-w-0">
          <Heading className="truncate text-sm font-medium leading-tight text-foreground">
            {display}
          </Heading>
          <p className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
            {agent.id}
          </p>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted-foreground">{agent.purpose}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:w-40">
        <Badge variant="neutral" caps>
          Built-in
        </Badge>
        <span className="text-[11px] text-muted-foreground">{RUNG_LABEL[agent.rung]}</span>
      </div>
    </article>
  );
}
