import { useLoaderData, useRouteError } from "@remix-run/react";
import { PageShell } from "~/components/page-shell";
import { RoutineAuthoringStudio } from "~/components/routines/routine-authoring-studio";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { getRoutineAuthoringBase } from "~/lib/routines/authoring";

export async function clientLoader({ params }: { params: { slug: string } }) {
  return getRoutineAuthoringBase(params.slug);
}

export default function RoutineAuthoringRoute() {
  const { definition, baseCommit } = useLoaderData<typeof clientLoader>();
  return (
    <PageShell
      crumbs={[
        { label: "Routines", to: "/routines" },
        {
          label: definition.metadata.slug,
          to: `/routines/${encodeURIComponent(definition.metadata.slug)}`,
        },
        { label: "Author" },
      ]}
      title={`Author ${definition.metadata.displayName}`}
      description={`Draft version ${definition.metadata.authoredVersion + 1}. Publication remains behind validation and Approval.`}
    >
      <RoutineAuthoringStudio definition={definition} baseCommit={baseCommit} />
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="Routine authoring" status={status} message={message} />;
}
