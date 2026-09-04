import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";

function chatHref(agentName: string, draft?: string): string {
  const params = new URLSearchParams({ agent: agentName });
  if (draft) params.set("draft", draft);
  return `/?${params}`;
}

/**
 * The authored example prompts, as the fastest way to actually use the agent.
 *
 * `suggestions` and `placeholder` are written in AGENT.md by whoever built the agent, so they are
 * the closest thing to first-party documentation the agent has. Each one links to chat with the
 * agent selected and the prompt drafted into the composer — drafted, never sent, so the reader
 * still owns the first turn. There is no blank-chat link here on purpose: the header's primary
 * button already is one, and a second copy in a lesser style reads as a disabled sibling.
 */
export function AgentStarters({
  name,
  suggestions = [],
  placeholder = [],
}: {
  name: string;
  suggestions?: readonly string[];
  placeholder?: readonly string[];
}) {
  const starters = suggestions.length > 0 ? suggestions : placeholder;

  if (starters.length === 0) return null;

  return (
    <Panel
      title="How to use it"
      description="Pick a starting point. The prompt is drafted into the composer for you, never sent."
    >
      <div className="flex flex-wrap gap-2">
        {starters.map((starter) => (
          <Link
            key={starter}
            to={chatHref(name, starter)}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none transition-colors hover:border-primary/40 hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {starter}
          </Link>
        ))}
      </div>
    </Panel>
  );
}
