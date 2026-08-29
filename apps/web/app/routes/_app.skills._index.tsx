import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { ResourcePanel } from "~/components/resource-panel";
import { SkillsTabs } from "~/components/skills-tabs";
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

  return (
    <ResourcePanel crumbs={[{ label: "skills" }]}>
      <SkillsTabs />
      <p className="text-xs text-muted-foreground">
        A skill is <span className="text-foreground">what</span> gets done: a procedure an{" "}
        <Link to="/agents" className="cursor-pointer underline underline-offset-2">
          agent
        </Link>{" "}
        loads for one task. You never talk to a skill, and a skill grants no permissions of its own.
      </p>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {skills.length} {skills.length === 1 ? "skill" : "skills"}
        </p>
        <Button asChild size="sm">
          <Link to="/skills/marketplace">Browse marketplace</Link>
        </Button>
      </div>
      {skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No skills installed yet, browse the marketplace to add one.
        </p>
      ) : (
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
      )}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="skills" status={status} message={message} />;
}
