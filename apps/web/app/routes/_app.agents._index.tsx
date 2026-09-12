import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { AgentRoster } from "~/components/agents/roster";
import { EmptyState } from "~/components/empty-state";
import { PageShell } from "~/components/page-shell";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { listAgents } from "~/lib/agents";
import { ApiError } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Agents · tulipfarm" }];

const createAgentHref = `/?draft=${encodeURIComponent(
  "Help me create an agent for my business. Ask what work it should own, then help me set its instructions, skills and limits before creating it."
)}`;

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
          hint="Give recurring work to an agent with its own instructions and limits. Describe the job in chat, and build its brief together."
        >
          <Button asChild>
            <Link to={createAgentHref}>Create an agent in chat</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/skills">Browse skills</Link>
          </Button>
        </EmptyState>
      </PageShell>
    );
  }

  return (
    <PageShell
      crumbs={[{ label: "Agents" }]}
      title="Agents"
      actions={
        <Button asChild size="sm">
          <Link to={createAgentHref}>Create an agent in chat</Link>
        </Button>
      }
    >
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
