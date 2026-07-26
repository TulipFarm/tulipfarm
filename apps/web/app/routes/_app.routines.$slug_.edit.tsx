import { useLoaderData, useRouteError } from "@remix-run/react";
import { ResourcePanel } from "~/components/resource-panel";
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
    <ResourcePanel
      crumbs={[
        { label: "routines", to: "/routines" },
        {
          label: definition.metadata.slug,
          to: `/routines/${encodeURIComponent(definition.metadata.slug)}`,
        },
        { label: "edit" },
      ]}
    >
      <div className="flex flex-col gap-1">
        <h1 className="font-medium text-foreground">Author {definition.metadata.displayName}</h1>
        <p className="text-muted-foreground text-sm">
          Draft version {definition.metadata.authoredVersion + 1}. Publication remains behind
          validation and Approval.
        </p>
      </div>
      <RoutineAuthoringStudio definition={definition} baseCommit={baseCommit} />
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="Routine authoring" status={status} message={message} />;
}
