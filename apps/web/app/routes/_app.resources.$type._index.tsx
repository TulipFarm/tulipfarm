import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "@remix-run/react";
import { useMemo, useState } from "react";
import { ChevronRight, Columns3, Pencil, Plus, Search, Trash2, Zap } from "~/components/icons";
import { PageShell } from "~/components/page-shell";
import { SchemaSummary } from "~/components/resources/schema-summary";
import { StatStrip } from "~/components/resources/stat-strip";
import { SchemaTable } from "~/components/schema-table";
import { ErrorState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { ConfirmModal } from "~/components/ui/modal";
import {
  ApiError,
  deleteResourceType,
  listRecords,
  listResourceCatalog,
  listResourceTypes,
  type ResourceRecord,
} from "~/lib/api";
import { isSystemFieldName } from "~/lib/resource-catalog";
import {
  availableColumns,
  deriveFields,
  detailFields,
  type FieldDescriptor,
  filterRecords,
  formatCount,
  listColumns,
  parseSchema,
  type SortState,
  sortRecords,
  timeAgo,
} from "~/lib/schema";
import { cn } from "~/lib/utils";

const PAGE_SIZE = 25;

export const meta: MetaFunction = () => [{ title: "Resources · tulipfarm" }];

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
  const type = params.type;
  if (!type) throw new ApiError(404, "missing resource type");

  // No single-type schema endpoint exists — fetch the collection and pick this type's schema.
  // Totals and the first page go out alongside it; none of the three depends on another.
  const [types, totals, page] = await Promise.all([
    listResourceTypes(),
    listResourceCatalog().catch(() => []),
    listRecords(type),
  ]);
  const summary = types.find((t) => t.name === type);
  if (!summary) throw new ApiError(404, `resource type not found: ${type}`);

  const parsed = parseSchema(summary.schema);
  const fields = parsed.ok ? deriveFields(parsed.schema) : [];
  const columns: FieldDescriptor[] = parsed.ok ? availableColumns(fields, parsed.schema) : [];
  const defaultColumns = parsed.ok
    ? listColumns(fields, parsed.schema).map((c) => c.name)
    : ([] as string[]);
  const total = totals.find((t) => t.name === type) ?? null;

  return {
    type,
    domain: summary.domain ?? null,
    hasHooks: summary.hasHooks,
    idStrategy: parsed.ok ? (parsed.schema["x-id-strategy"] ?? null) : null,
    schemaFields: parsed.ok ? detailFields(fields, parsed.schema) : [],
    // Counts the type's own properties, so "Fields" means the same number the catalog shows.
    // detailFields appends the runtime-managed block, which would make this page disagree with
    // the row the reader clicked to get here.
    fieldCount: fields.filter((f) => !f.isSystem).length,
    idField: parsed.ok ? (parsed.schema["x-id-strategy"]?.field ?? "id") : "id",
    linkTargets: parsed.ok
      ? [...new Set(fields.flatMap((f) => (f.linkTarget ? [f.linkTarget] : [])))].sort()
      : [],
    columns,
    defaultColumns,
    schemaError: parsed.ok ? undefined : parsed.error,
    items: page.items,
    nextCursor: page.nextCursor,
    recordCount: total?.count ?? null,
    lastUpdatedAt: total?.lastUpdatedAt ?? null,
  };
}

/**
 * React Router keeps this route's component mounted across a `/resources/:type` →
 * `/resources/:other` navigation — only `params` and loader data change. Every piece of view state
 * below is seeded from loader data on first mount, so without a remount the new type would render
 * the previous type's records, keyset cursor, column selection, query, sort and page. Keying the
 * view on the type is what makes that navigation behave like arriving fresh.
 */
export default function ResourceList() {
  const { type } = useLoaderData<typeof clientLoader>();
  return <ResourceListView key={type} />;
}

function ResourceListView() {
  const data = useLoaderData<typeof clientLoader>();
  const { type, columns, defaultColumns, schemaError, items, nextCursor } = data;
  const navigate = useNavigate();

  const [records, setRecords] = useState<ResourceRecord[]>(items);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typeError, setTypeError] = useState<string | null>(null);
  const [confirmingDeleteType, setConfirmingDeleteType] = useState(false);
  const [deletingType, setDeletingType] = useState(false);

  // Client view over the loaded set: filter → sort → page. "Load more" feeds more server rows in.
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(defaultColumns);
  const [density, setDensity] = useState<"compact" | "comfortable">("comfortable");

  const shown = useMemo(
    () => columns.filter((c) => visibleColumns.includes(c.name)),
    [columns, visibleColumns]
  );
  // The picker lists the type's own fields first; runtime-managed ones are rarely what you came for.
  const pickerColumns = useMemo(
    () => [
      ...columns.filter((c) => !isSystemFieldName(c.name)),
      ...columns.filter((c) => isSystemFieldName(c.name)),
    ],
    [columns]
  );
  const filtered = useMemo(() => filterRecords(records, shown, query), [records, shown, query]);
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.name === sort.field);
    return col ? sortRecords(filtered, col, sort.dir) : filtered;
  }, [filtered, columns, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

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

  function toggleSort(column: string) {
    setSort((prev) =>
      prev?.field === column
        ? { field: column, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { field: column, dir: "asc" }
    );
    setPage(0);
  }

  function toggleColumn(name: string) {
    setVisibleColumns((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );
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

  const idLabel = data.idStrategy?.sequence
    ? `${data.idStrategy.prefix ?? "auto"}-n`
    : (data.idStrategy?.field ?? "id");

  return (
    <PageShell
      crumbs={[{ label: "Resources", to: "/resources" }, { label: type }]}
      title={type}
      meta={
        <>
          {data.domain ? <Badge variant="neutral">{data.domain}</Badge> : null}
          {data.hasHooks ? (
            <Badge variant="info" title="This type runs hooks on write">
              <Zap aria-hidden className="size-3" />
              Hooks
            </Badge>
          ) : null}
          {data.linkTargets.map((target) => (
            <Link key={target} to={`/resources/${encodeURIComponent(target)}`}>
              <Badge
                variant="neutral"
                className="transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {"\u2192"} {target}
              </Badge>
            </Link>
          ))}
        </>
      }
      actions={
        <>
          <Button asChild size="sm">
            <Link to={`/resources/${encodeURIComponent(type)}/new`}>
              <Plus aria-hidden className="size-4" />
              New record
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/resources/${encodeURIComponent(type)}/schema`}>
              <Pencil aria-hidden className="size-4" />
              Edit schema
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingDeleteType(true)}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 aria-hidden className="size-4" />
            Delete type
          </Button>
        </>
      }
    >
      <ConfirmModal
        open={confirmingDeleteType}
        onClose={() => setConfirmingDeleteType(false)}
        onConfirm={() => void onDeleteType()}
        title="Delete resource type"
        description={`Delete the "${type}" resource type? Its records are kept in the database but the type is removed.`}
        confirmLabel="Delete type"
        busy={deletingType}
      />

      {typeError ? (
        <p role="alert" className="text-sm text-destructive">
          {typeError}
        </p>
      ) : null}

      {schemaError ? (
        <div className="rounded-md border border-status-danger/30 bg-status-danger/10 px-4 py-3 text-sm">
          <p className="font-medium text-status-danger">This type&rsquo;s schema will not parse</p>
          <p className="mt-1 text-muted-foreground">
            {schemaError}. Records are still stored, but no column can be derived until the schema
            is valid.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link to={`/resources/${encodeURIComponent(type)}/schema`}>Edit schema</Link>
          </Button>
        </div>
      ) : (
        <>
          <StatStrip
            stats={[
              {
                label: "Records",
                value: formatCount(data.recordCount),
                muted: data.recordCount === null,
              },
              { label: "Fields", value: data.fieldCount },
              { label: "Links", value: data.linkTargets.length },
              { label: "Record id", value: idLabel, muted: !data.idStrategy?.sequence },
              {
                label: "Last write",
                value: data.lastUpdatedAt ? timeAgo(data.lastUpdatedAt) : "Never",
                ...(data.lastUpdatedAt
                  ? { title: new Date(data.lastUpdatedAt).toLocaleString() }
                  : {}),
                muted: data.lastUpdatedAt === null,
              },
            ]}
          />

          <div className="flex flex-col gap-3">
            {/* Filter, density and the column picker all act on rows. With none loaded they are
                three controls that cannot do anything, above an empty state that can. */}
            {records.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 sm:max-w-xs">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-4 text-muted-foreground"
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(0);
                    }}
                    aria-label={`Filter ${type} records`}
                    placeholder="Filter loaded records"
                    className="ps-8"
                  />
                </div>

                <fieldset className="flex items-center gap-1 rounded-md border border-input p-0.5">
                  <legend className="sr-only">Row height</legend>
                  {(["comfortable", "compact"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={density === option}
                      onClick={() => setDensity(option)}
                      className={cn(
                        "rounded-sm px-2 py-1 text-xs capitalize transition-colors",
                        density === option
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </fieldset>

                <p aria-live="polite" className="ms-auto text-xs text-muted-foreground">
                  {query
                    ? `${sorted.length} of ${records.length} loaded`
                    : `${records.length} loaded${cursor ? ", more on the server" : ""}`}
                </p>
              </div>
            ) : null}

            {/* Expands in flow rather than overlaying: no z-index, no click-outside to get wrong. */}
            {records.length > 0 ? (
              <details className="group rounded-lg border border-border bg-card">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent">
                  <ChevronRight
                    aria-hidden
                    className="size-4 text-muted-foreground transition-transform duration-100 group-open:rotate-90"
                  />
                  <Columns3 aria-hidden className="size-4 text-muted-foreground" />
                  Columns
                  <span className="text-muted-foreground">
                    {shown.length} of {columns.length}
                  </span>
                </summary>
                <fieldset className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border px-3 py-3">
                  <legend className="sr-only">Visible columns</legend>
                  {pickerColumns.map((col) => (
                    <label
                      key={col.name}
                      className="flex items-center gap-2 text-sm text-muted-foreground"
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(col.name)}
                        onChange={() => toggleColumn(col.name)}
                        // Adjacent inline spans concatenate without a space, so the badge would
                        // otherwise be announced as "createdAtsystem".
                        aria-label={
                          isSystemFieldName(col.name) ? `${col.name}, runtime-managed` : col.name
                        }
                        className="size-4 accent-primary"
                      />
                      <span className={cn(visibleColumns.includes(col.name) && "text-foreground")}>
                        {col.name}
                      </span>
                      {isSystemFieldName(col.name) ? (
                        <span aria-hidden className="text-xs text-muted-foreground">
                          system
                        </span>
                      ) : null}
                    </label>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ms-auto"
                    onClick={() => setVisibleColumns(defaultColumns)}
                  >
                    Reset
                  </Button>
                </fieldset>
              </details>
            ) : null}

            {records.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-6 py-12 text-center">
                <p className="text-sm font-medium text-foreground">No {type} records yet</p>
                <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
                  Records land here when you add one, when an agent writes one, or when a routine
                  creates one.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-4">
                  <Link to={`/resources/${encodeURIComponent(type)}/new`}>
                    <Plus aria-hidden className="size-4" />
                    New record
                  </Link>
                </Button>
              </div>
            ) : shown.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
                Every column is hidden. Pick at least one under Columns.
              </div>
            ) : sorted.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-6 py-10 text-center">
                <p className="text-sm text-foreground">
                  No loaded record matches &ldquo;{query}&rdquo;
                </p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setQuery("")}>
                  Clear filter
                </Button>
              </div>
            ) : (
              <SchemaTable
                columns={shown}
                records={pageItems}
                type={type}
                sort={sort ?? undefined}
                onToggleSort={toggleSort}
                density={density}
              />
            )}

            {loadError ? (
              <p role="alert" className="text-sm text-destructive">
                {loadError}
              </p>
            ) : null}

            {pageCount > 1 || cursor ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {pageCount > 1 ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(safePage - 1)}
                      disabled={safePage === 0}
                    >
                      Previous
                    </Button>
                    <span className="tabular-nums text-muted-foreground">
                      Page {safePage + 1} of {pageCount}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(safePage + 1)}
                      disabled={safePage >= pageCount - 1}
                    >
                      Next
                    </Button>
                  </>
                ) : null}
                {cursor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ms-auto"
                    onClick={loadMore}
                    disabled={loading}
                  >
                    {loading ? "Loading…" : "Load more from server"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <SchemaSummary fields={data.schemaFields} idField={data.idField} />
        </>
      )}
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="resources" status={status} message={message} />;
}
