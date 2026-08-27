import {
  type ClientLoaderFunctionArgs,
  Link,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useMemo, useState } from "react";
import { ResourcePanel } from "~/components/resource-panel";
import { SchemaTable } from "~/components/schema-table";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
import {
  ApiError,
  deleteResourceType,
  listRecords,
  listResourceTypes,
  type ResourceRecord,
} from "~/lib/api";
import {
  deriveFields,
  type FieldDescriptor,
  filterRecords,
  listColumns,
  parseSchema,
  type SortState,
  sortRecords,
} from "~/lib/schema";

const PAGE_SIZE = 25;

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
  const navigate = useNavigate();
  const [records, setRecords] = useState<ResourceRecord[]>(items);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typeError, setTypeError] = useState<string | null>(null);
  const [confirmingDeleteType, setConfirmingDeleteType] = useState(false);
  const [deletingType, setDeletingType] = useState(false);

  async function onDeleteType() {
    if (deletingType) return;
    setDeletingType(true);
    setTypeError(null);
    try {
      await deleteResourceType(type);
      navigate("/resources");
    } catch (err) {
      setTypeError(err instanceof ApiError ? err.message : "failed to delete type");
    } finally {
      setDeletingType(false);
      setConfirmingDeleteType(false);
    }
  }

  // Client view over the loaded set: filter → sort → page. "Load more" feeds more server rows in.
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => filterRecords(records, columns, query), [records, columns, query]);
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.name === sort.field);
    return col ? sortRecords(filtered, col, sort.dir) : filtered;
  }, [filtered, columns, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  function toggleSort(column: string) {
    setSort((prev) =>
      prev?.field === column
        ? { field: column, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { field: column, dir: "asc" }
    );
    setPage(0);
  }

  function onQueryChange(value: string) {
    setQuery(value);
    setPage(0);
  }

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    setLoadError(null);
    try {
      const batch = await listRecords(type, cursor);
      setRecords((prev) => [...prev, ...batch.items]);
      setCursor(batch.nextCursor);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "failed to load more");
    } finally {
      setLoading(false);
    }
  }

  const crumbs = [{ label: "resources", to: "/resources" }, { label: type }];

  return (
    <ResourcePanel crumbs={crumbs}>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to={`/resources/${encodeURIComponent(type)}/new`}>New {type}</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={`/resources/${encodeURIComponent(type)}/schema`}>Edit type</Link>
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setConfirmingDeleteType(true)}>
          Delete type
        </Button>
      </div>
      <ConfirmModal
        open={confirmingDeleteType}
        onClose={() => setConfirmingDeleteType(false)}
        onConfirm={() => void onDeleteType()}
        title="Delete resource type"
        description={`Delete the "${type}" resource type? Its records are kept in the database but the type is removed.`}
        confirmLabel="Delete type"
        busy={deletingType}
      />
      {typeError ? <p className="text-destructive">error: {typeError}</p> : null}
      {schemaError ? (
        <p className="text-destructive">error: schema parse failed, {schemaError}</p>
      ) : records.length === 0 ? (
        <p className="text-muted-foreground">0 results</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="filter…"
              aria-label="filter records"
              className="h-8 w-64 rounded-sm border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="text-xs text-muted-foreground">
              {query ? `${sorted.length} of ${records.length}` : `${records.length} results`}
            </span>
          </div>
          {sorted.length === 0 ? (
            <p className="text-muted-foreground">0 results</p>
          ) : (
            <SchemaTable
              columns={columns}
              records={pageItems}
              type={type}
              sort={sort ?? undefined}
              onToggleSort={toggleSort}
            />
          )}
          {loadError ? <p className="text-destructive">error: {loadError}</p> : null}
          {pageCount > 1 ? (
            <div className="flex items-center gap-3 text-sm">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage === 0}
              >
                prev
              </Button>
              <span className="text-muted-foreground">
                page {safePage + 1} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage >= pageCount - 1}
              >
                next
              </Button>
            </div>
          ) : null}
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
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="resources" status={status} message={message} />;
}
