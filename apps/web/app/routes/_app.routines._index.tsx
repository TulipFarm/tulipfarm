import { Link, useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { ApiError } from "~/lib/api";
import { listRoutines, type RoutineTrigger } from "~/lib/routines";

export async function clientLoader() {
  const routines = await listRoutines();
  return { routines };
}

function triggerLabel(trigger: RoutineTrigger): string {
  return trigger.summary;
}

export default function RoutinesIndex() {
  const { routines } = useLoaderData<typeof clientLoader>();

  if (routines.length === 0) {
    return (
      <EmptyState
        section="routines"
        title="Routines"
        hint="No published Routines yet. Ask the assistant to create and publish one."
      />
    );
  }

  return (
    <ResourcePanel crumbs={[{ label: "routines" }]}>
      <p className="text-xs text-muted-foreground">
        {routines.length} {routines.length === 1 ? "routine" : "routines"}
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
        {routines.map((routine) => (
          <li key={routine.slug}>
            <div className="flex items-center gap-2.5 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">{routine.displayName ?? routine.slug}</p>
                <p className="text-xs text-muted-foreground">
                  {routine.slug} · version {routine.authoredVersion}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                {routine.triggers.map((trigger) => (
                  <span
                    key={trigger.slug}
                    className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-[0.15em]"
                  >
                    {triggerLabel(trigger)}
                  </span>
                ))}
              </span>
              <Link
                to={`/routines/${encodeURIComponent(routine.slug)}/edit`}
                className="text-xs text-primary hover:underline"
              >
                author
              </Link>
            </div>
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
  return <ErrorState section="routines" status={status} message={message} />;
}
