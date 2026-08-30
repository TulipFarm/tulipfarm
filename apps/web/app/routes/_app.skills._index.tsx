import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { PageShell } from "~/components/page-shell";
import { SkillCatalog } from "~/components/skills/skill-catalog";
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
    <PageShell
      crumbs={[{ label: "Skills" }]}
      title="Skills"
      description={
        <>
          A skill is <span className="text-foreground">what</span> gets done: a procedure an{" "}
          <Link to="/agents" className="underline underline-offset-2">
            agent
          </Link>{" "}
          loads for one task. You never talk to a skill, and a skill grants no permissions of its
          own.
        </>
      }
      actions={
        <Button asChild size="sm">
          <Link to="/skills/marketplace">Browse marketplace</Link>
        </Button>
      }
    >
      <SkillsTabs />
      <SkillCatalog skills={skills} />
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="skills" status={status} message={message} />;
}
