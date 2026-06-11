import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useParams,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { ResourcePanel } from "~/components/resource-panel";
import { SchemaTable } from "~/components/schema-table";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError, listRecords, listResourceTypes, type ResourceRecord } from "~/lib/api";
import { deriveFields, type FieldDescriptor, listColumns, parseSchema } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "Resources · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const type = params.type;
  if (!type) throw new ApiError(404, "missing resource type");

  // No single-type schema endpoint exists — fetch the collection and pick this type's schema.
  const types = await listResourceTypes();
  const summary = types.find((t) => t.name === type);
  if (!summary) throw new ApiError(404, `resource type not found: ${type}`);

  const parsed = parseSchema(summary.schema);
  const columns: FieldDescriptor[] = parsed.ok
    ? listColumns(deriveFields(parsed.schema), parsed.schema)
    : [];
  const schemaError = parsed.ok ? undefined : parsed.error;

  const page = await listRecords(type);
  return { type, columns, schemaError, items: page.items, nextCursor: page.nextCursor };
}

export default function ResourceList() {
  const { type, columns, schemaError, items, nextCursor } = useLoaderData<typeof clientLoader>();
  const [records, setRecords] = useState<ResourceRecord[]>(items);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await listRecords(type, cursor);
      setRecords((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "failed to load more");
    } finally {
      setLoading(false);
    }
  }

  const crumbs = [{ label: "resources", to: "/resources" }, { label: type }];
  const command = `tulipfarm resources ${type} --list`;

  return (
    <ResourcePanel crumbs={crumbs} command={command}>
      <div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/resources/${encodeURIComponent(type)}/new`}>New {type}</Link>
        </Button>
      </div>
      {schemaError ? (
        <p className="text-destructive">error: schema parse failed — {schemaError}</p>
      ) : records.length === 0 ? (
        <p className="text-muted-foreground">0 results</p>
      ) : (
        <>
          <SchemaTable columns={columns} records={records} type={type} />
          {loadError ? <p className="text-destructive">error: {loadError}</p> : null}
          {cursor ? (
            <div>
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
                {loading ? "loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const params = useParams();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return (
    <ErrorState
      section="resources"
      command={`tulipfarm resources ${params.type ?? ""} --list`}
      status={status}
      message={message}
    />
  );
}
