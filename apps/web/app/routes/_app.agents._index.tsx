import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { AgentRoster } from "~/components/agents/roster";
import { EmptyState } from "~/components/empty-state";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Link } from "~/components/ui/link";
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
      <PageShell crumbs={[{ label: "Agents" }]} title="Agents">
        <EmptyState
          section="agents"
          title="No agents yet"
          hint="An agent is who does the work: a named worker with its own instructions and its own limits. Ask in chat for one. To make an existing agent better at a single task, add a skill instead."
        />
      </PageShell>
    );
  }

  return (
    <PageShell crumbs={[{ label: "Agents" }]} title="Agents">
      <p className="text-xs text-muted-foreground">
        An agent is <span className="text-foreground">who</span> does the work. It holds its own
        instructions and limits, and you talk to it.{" "}
        <Link to="/skills" className="cursor-pointer underline underline-offset-2">
          Skills
        </Link>{" "}
        are the procedures an agent loads for one task.
      </p>
      <AgentRoster agents={agents} />
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="agents" status={status} message={message} />;
}
