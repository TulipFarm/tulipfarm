import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { AgentGlyph } from "~/components/agent-glyph";
import { EmptyState } from "~/components/empty-state";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { listAgents } from "~/lib/agents";
import { ApiError } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Agents · tulipfarm" }];

export async function clientLoader() {
  const agents = await listAgents();
  return { agents };
}

export default function AgentsIndex() {
  const { agents } = useLoaderData<typeof clientLoader>();

  if (agents.length === 0) {
    return (
      <EmptyState
        section="agents"
        title="Agents"
        hint="An agent is who does the work: a named worker with its own instructions and its own limits. Ask in chat for one. To make an existing agent better at a single task, add a skill instead."
      />
    );
  }

  return (
    <ResourcePanel crumbs={[{ label: "Agents" }]}>
      <p className="text-xs text-muted-foreground">
        An agent is <span className="text-foreground">who</span> does the work. It holds its own
        instructions and limits, and you talk to it.{" "}
        <Link to="/skills" className="cursor-pointer underline underline-offset-2">
          Skills
        </Link>{" "}
        are the procedures an agent loads for one task.
      </p>
      <p className="text-xs text-muted-foreground">
        {agents.length} {agents.length === 1 ? "agent" : "agents"}
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
        {agents.map((agent) => (
          <li key={agent.name}>
            <Link
              to={`/agents/${encodeURIComponent(agent.name)}`}
              className="group flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent"
            >
              <AgentGlyph
                name={agent.name}
                domain={agent.domain}
                autonomy={agent.autonomy}
                size="sm"
                decorative
                className="shrink-0"
              />
              <span className="font-medium text-foreground">{agent.label ?? agent.name}</span>
              {agent.description ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {agent.description}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {agent.domain ? <span>{agent.domain}</span> : null}
                {agent.autonomy ? (
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-[0.15em]">
                    {agent.autonomy}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="agents" status={status} message={message} />;
}
