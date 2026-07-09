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
  switch (trigger.type) {
    case "cron":
      return `cron ${trigger.schedule}`;
    case "event":
      return `on ${trigger.event}`;
    default:
      return trigger.type;
  }
}

export default function RoutinesIndex() {
  const { routines } = useLoaderData<typeof clientLoader>();

  if (routines.length === 0) {
    return (
      <EmptyState
        section="routines"
        title="Routines"
        hint="No routines yet. Ask the assistant to forge one, or add soul/routines/<slug>/routine.yaml."
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
            {routine.valid ? (
              <Link
                to={`/routines/${encodeURIComponent(routine.slug)}`}
                className="group flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent"
              >
                <span className="font-medium text-foreground">{routine.name ?? routine.slug}</span>
                {routine.description ? (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {routine.description}
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {(routine.triggers ?? []).map((t, i) => (
                    <span
                      key={`${t.type}-${i.toString()}`}
                      className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-[0.15em]"
                    >
                      {triggerLabel(t)}
                    </span>
                  ))}
                </span>
              </Link>
            ) : (
              <div className="flex items-center gap-2.5 px-3 py-2">
                <span className="font-medium text-foreground">{routine.slug}</span>
                <span
                  className="min-w-0 flex-1 truncate text-destructive text-xs"
                  title={routine.loadError ?? undefined}
                >
                  invalid: {routine.loadError}
                </span>
              </div>
            )}
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
