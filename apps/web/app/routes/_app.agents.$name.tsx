import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { AgentGlyph } from "~/components/agent-glyph";
import { MarkdownView } from "~/components/markdown-view";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { getAgent } from "~/lib/agents";
import { ApiError } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Agents · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing agent name");
  const agent = await getAgent(name);
  return { agent };
}

function MetaRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{value}</dd>
    </div>
  );
}

export default function AgentDetail() {
  const { agent } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const display = agent.label ?? agent.name;
  const hasMeta = Boolean(agent.label || agent.domain || agent.model || agent.autonomy);

  return (
    <ResourcePanel crumbs={[{ label: "agents", to: "/agents" }, { label: agent.name }]}>
      <div className="flex items-center gap-3">
        <AgentGlyph
          name={agent.name}
          domain={agent.domain}
          autonomy={agent.autonomy}
          size="lg"
          decorative
          className="shrink-0"
        />
        <h1 className="text-lg font-semibold text-foreground">{display}</h1>
      </div>

      <div>
        {/* Chat is wired in a later ticket; this preselects the agent on the chat surface. */}
        <Button size="sm" onClick={() => navigate(`/?agent=${encodeURIComponent(agent.name)}`)}>
          Chat with {display}
        </Button>
      </div>

      {agent.description ? <p className="text-muted-foreground">{agent.description}</p> : null}

      {hasMeta ? (
        <dl className="flex flex-col rounded-sm border border-border">
          <MetaRow label="label" value={agent.label} />
          <MetaRow label="domain" value={agent.domain} />
          <MetaRow label="model" value={agent.model} />
          <MetaRow label="autonomy" value={agent.autonomy} />
        </dl>
      ) : null}

      <div className="border-t border-border pt-4">
        <MarkdownView>{agent.body}</MarkdownView>
      </div>
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState section="agents" />;
  }
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="agents" status={status} message={message} />;
}
