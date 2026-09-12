import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { PageShell } from "~/components/page-shell";
import { SkillCatalog } from "~/components/skills/skill-catalog";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import { type AgentSummary, listAgents } from "~/lib/agents";
import { ApiError } from "~/lib/api";
import { listSkills } from "~/lib/skills";

export const meta: MetaFunction = () => [{ title: "Skills · tulipfarm" }];

export async function clientLoader() {
  const [skills, agents] = await Promise.all([
    listSkills(),
    listAgents().catch((): AgentSummary[] => []),
  ]);
  return { skills, agents };
}

export default function SkillsIndex() {
  const { skills, agents } = useLoaderData<typeof clientLoader>();

  return (
    <PageShell
      crumbs={[{ label: "Skills" }]}
      title="Skills"
      actions={
        skills.length > 0 ? (
          <Button asChild size="sm">
            <Link to="/skills/marketplace">Browse marketplace</Link>
          </Button>
        ) : undefined
      }
    >
      {skills.length > 0 ? (
        <SkillCatalog skills={skills} agents={agents} />
      ) : (
        <EmptyState
          section="Skills"
          title="No skills installed yet"
          hint="Find a skill in the marketplace, then review its audit before installing."
        >
          <Button asChild>
            <Link to="/skills/marketplace">Browse marketplace</Link>
          </Button>
        </EmptyState>
      )}
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="skills" status={status} message={message} />;
}
