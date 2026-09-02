import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { AgentGlyph } from "~/components/agent-glyph";
import { CapabilityPanel } from "~/components/agents/capability-panel";
import { AgentGovernanceCard } from "~/components/agents/governance-card";
import { AgentStarters } from "~/components/agents/starters";
import { AutonomyChip } from "~/components/autonomy-chip";
import { MarkdownView } from "~/components/markdown-view";
import { PageShell } from "~/components/page-shell";
import { ErrorState, NotFoundState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";
import { agentDisplayName, capabilityFacts } from "~/lib/agent-capabilities";
import { getAgent, proposeAgentCandidate } from "~/lib/agents";
import { ApiError } from "~/lib/api";

export const meta: MetaFunction = () => [{ title: "Agents · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const name = params.name;
  if (!name) throw new ApiError(404, "missing agent name");
  const agent = await getAgent(name);
  return { agent };
}

function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xs text-foreground">{value}</dd>
    </div>
  );
}

export default function AgentDetail() {
  const { agent } = useLoaderData<typeof clientLoader>();
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<string>();
  const display = agentDisplayName(agent);
  const facts = capabilityFacts(agent.capabilityRestrictions);

  return (
    <PageShell
      crumbs={[{ label: "Agents", to: "/agents" }, { label: agent.name }]}
      title={display}
      description={
        <>
          <span className="block font-mono text-xs">{agent.name}</span>
          {agent.description ? <span className="mt-2 block">{agent.description}</span> : null}
        </>
      }
      meta={
        /* The label already reads as the heading above, so it is deliberately not repeated here. */
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <AgentGlyph
            name={agent.name}
            domain={agent.domain}
            autonomy={agent.autonomy}
            size="sm"
            decorative
          />
          <Fact label="domain" value={agent.domain} />
          <Fact label="model" value={agent.model} />
          {agent.autonomy ? (
            <div className="flex items-baseline gap-1.5">
              <dt className="text-xs text-muted-foreground">authority</dt>
              <dd>
                <AutonomyChip autonomy={agent.autonomy} size="xs" className="text-[10px]" />
              </dd>
            </div>
          ) : null}
        </dl>
      }
      actions={
        <Button asChild size="sm">
          <Link
            to={`/?agent=${encodeURIComponent(agent.name)}`}
            aria-label={`Start a chat with ${display}`}
          >
            Start a chat
          </Link>
        </Button>
      }
    >
      <AgentStarters
        name={agent.name}
        suggestions={agent.suggestions}
        placeholder={agent.placeholder}
      />

      <CapabilityPanel facts={facts} />

      <Panel
        title="Who can use it"
        description="Anyone signed in to this instance can start a chat with this agent. The team it works for decides who can open the documents it writes."
      >
        <Button asChild size="sm" variant="outline">
          <Link to="/business/access/agents" aria-label={`Manage teams for ${display}`}>
            Manage teams
          </Link>
        </Button>
      </Panel>

      {agent.governance ? (
        <AgentGovernanceCard
          governance={agent.governance}
          busy={publishing}
          result={publishResult}
          onPublish={async () => {
            const governance = agent.governance;
            if (!governance) return;
            setPublishing(true);
            setPublishResult(undefined);
            try {
              const result = await proposeAgentCandidate(agent.name, governance);
              setPublishResult(`${result.status} · ${result.changesetId}`);
            } catch (error) {
              setPublishResult(error instanceof Error ? error.message : "Publication failed");
            } finally {
              setPublishing(false);
            }
          }}
        />
      ) : null}

      {/*
        No panel title here: the agent's own markdown opens with its own headings, and a frame
        title would outrank nothing while looking smaller than the headings it contains.
      */}
      <Panel description="The brief this agent is given on every turn, exactly as written.">
        <MarkdownView>{agent.body}</MarkdownView>
      </Panel>
    </PageShell>
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
