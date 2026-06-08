import { Link, type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { EmptyState } from "~/components/empty-state";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { ApiError, listResourceTypes } from "~/lib/api";
import { deriveFields, parseSchema } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "Resources · tulipfarm" }];

type TypeRow = { name: string; hasHooks: boolean; fieldCount: number };

export async function clientLoader() {
  const types = await listResourceTypes();
  const rows: TypeRow[] = types.map((t) => {
    const parsed = parseSchema(t.schema);
    return {
      name: t.name,
      hasHooks: t.hasHooks,
      fieldCount: parsed.ok ? deriveFields(parsed.schema).length : 0,
    };
  });
  return { rows };
}

export default function ResourcesIndex() {
  const { rows } = useLoaderData<typeof clientLoader>();

  if (rows.length === 0) {
    return (
      <EmptyState
        section="resources"
        title="Resources"
        hint="No resource types defined yet. Connect a soul to populate schema-driven CRUD."
      />
    );
  }

  return (
    <ResourcePanel crumbs={[{ label: "resources" }]} command="tulipfarm resources --list">
      <p className="text-xs text-muted-foreground">
        {rows.length} {rows.length === 1 ? "type" : "types"}
      </p>
      <ul className="flex flex-col rounded-sm border border-border divide-y divide-border">
        {rows.map((row) => (
          <li key={row.name}>
            <Link
              to={`/resources/${encodeURIComponent(row.name)}`}
              className="group flex items-baseline gap-2 px-3 py-2 transition-colors hover:bg-accent"
            >
              <span aria-hidden className="text-primary">
                ▸
              </span>
              <span className="font-medium text-foreground">{row.name}</span>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                {row.hasHooks ? (
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 uppercase tracking-[0.15em]">
                    hooks
                  </span>
                ) : null}
                <span>
                  {row.fieldCount} {row.fieldCount === 1 ? "field" : "fields"}
                </span>
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
      section="resources"
      command="tulipfarm resources --list"
      status={status}
      message={message}
    />
  );
}
