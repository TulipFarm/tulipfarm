import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { listSkills } from "~/lib/skills";

export const meta: MetaFunction = () => [{ title: "Skills · tulipfarm" }];

export async function clientLoader() {
  const skills = await listSkills();
  return { skills };
}

export default function SkillsIndex() {
  const { skills } = useLoaderData<typeof clientLoader>();

  if (skills.length === 0) {
    return (
      <EmptyState section="skills" title="Skills" hint="No skills installed yet.">
        <Button asChild size="sm" className="self-start">
          <Link to="/skills/install">Install from git</Link>
        </Button>
      </EmptyState>
    );
  }

  return (
    <ResourcePanel crumbs={[{ label: "skills" }]} command="tulipfarm skills --list">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {skills.length} {skills.length === 1 ? "skill" : "skills"}
        </p>
        <Button asChild size="sm">
          <Link to="/skills/install">Install from git</Link>
        </Button>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
        {skills.map((skill) => (
          <li key={skill.name}>
            <Link
              to={`/skills/${encodeURIComponent(skill.name)}`}
              className="group flex items-baseline gap-2 px-3 py-2 transition-colors hover:bg-accent"
            >
              <span aria-hidden className="text-primary">
                ▸
              </span>
              <span className="font-medium text-foreground">{skill.name}</span>
              {skill.description ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {skill.description}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
                {skill.provenance}
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
  return (
    <ErrorState
      section="skills"
      command="tulipfarm skills --list"
      status={status}
      message={message}
    />
  );
}
