import { type MetaFunction, useLoaderData, useRouteError } from "@remix-run/react";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { PageShell } from "~/components/page-shell";
import { CatalogTable } from "~/components/resources/catalog-table";
import { StatStrip } from "~/components/resources/stat-strip";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Select } from "~/components/ui/select";
import { ApiError, listResourceCatalog, listResourceTypes } from "~/lib/api";
import {
  buildCatalog,
  type CatalogSort,
  type CatalogSortKey,
  catalogDomains,
  filterCatalog,
  sortCatalog,
} from "~/lib/resource-catalog";
import { formatCount, timeAgo } from "~/lib/schema";

export const meta: MetaFunction = () => [{ title: "Resources · tulipfarm" }];

export async function clientLoader() {
  // Totals come from a separate, authorization-filtered surface, so a caller who may not list a
  // type still sees the type itself — with its size withheld rather than the whole page failing.
  const [types, totals] = await Promise.all([
    listResourceTypes(),
    listResourceCatalog().catch(() => []),
  ]);
  return { rows: buildCatalog(types, totals) };
}

export default function ResourcesIndex() {
  const { rows } = useLoaderData<typeof clientLoader>();
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<string | null>(null);
  const [sort, setSort] = useState<CatalogSort>({ key: "name", dir: "asc" });

  const domains = useMemo(() => catalogDomains(rows), [rows]);
  const visible = useMemo(
    () => sortCatalog(filterCatalog(rows, query, domain), sort),
    [rows, query, domain, sort]
  );

  const totals = useMemo(() => {
    const counted = rows.filter((r) => r.recordCount !== null);
    const lastWrite = rows.reduce<string | null>((latest, r) => {
      if (r.lastUpdatedAt === null) return latest;
      return latest === null || r.lastUpdatedAt > latest ? r.lastUpdatedAt : latest;
    }, null);
    return {
      records:
        counted.length === 0 ? null : counted.reduce((sum, r) => sum + (r.recordCount ?? 0), 0),
      partial: counted.length !== rows.length,
      relationships: rows.reduce((sum, r) => sum + r.links.length, 0),
      fields: rows.reduce((sum, r) => sum + r.fieldCount, 0),
      lastWrite,
    };
  }, [rows]);

  function toggleSort(key: CatalogSortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" || key === "domain" ? "asc" : "desc" }
    );
  }

  const filtering = query.trim() !== "" || domain !== null;

  const newTypeButton = (
    <Button asChild size="sm">
      <Link to="/resources/new">
        <Plus aria-hidden className="size-4" />
        New type
      </Link>
    </Button>
  );

  if (rows.length === 0) {
    return (
      <PageShell crumbs={[{ label: "Resources" }]} title="Resources" actions={newTypeButton}>
        <div className="rounded-md border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm font-medium text-foreground">No resource types yet</p>
          <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
            A resource type is a table your agents can read and write — a Ticket, a Customer, an
            Invoice. Describe one in chat and an agent will build it, or define the schema yourself.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            {newTypeButton}
            <Button asChild variant="outline" size="sm">
              <Link to="/">Ask in chat</Link>
            </Button>
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell crumbs={[{ label: "Resources" }]} title="Resources" actions={newTypeButton}>
      <StatStrip
        stats={[
          { label: "Types", value: rows.length },
          {
            label: "Records",
            value: formatCount(totals.records),
            ...(totals.partial ? { title: "Excludes types you cannot list", muted: true } : {}),
          },
          { label: "Fields", value: totals.fields },
          { label: "Relationships", value: totals.relationships },
          {
            label: "Last write",
            value: totals.lastWrite ? timeAgo(totals.lastWrite) : "Never",
            ...(totals.lastWrite ? { title: new Date(totals.lastWrite).toLocaleString() } : {}),
            muted: totals.lastWrite === null,
          },
        ]}
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              aria-hidden
              className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-4 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search resource types"
              placeholder="Search types, fields, links"
              className="ps-8"
            />
          </div>

          {domains.length > 0 ? (
            <div className="flex items-center gap-2">
              <label htmlFor="domain-filter" className="text-sm text-muted-foreground">
                Domain
              </label>
              <Select
                id="domain-filter"
                value={domain ?? ""}
                onChange={(e) => setDomain(e.target.value === "" ? null : e.target.value)}
                className="w-auto"
              >
                <option value="">All</option>
                {domains.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          <p aria-live="polite" className="ms-auto text-xs text-muted-foreground">
            {filtering
              ? `${visible.length} of ${rows.length} types`
              : `${rows.length} ${rows.length === 1 ? "type" : "types"}`}
          </p>
        </div>

        {visible.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-6 py-10 text-center">
            <p className="text-sm text-foreground">
              {query ? <>No type matches &ldquo;{query}&rdquo;</> : "No type is in that domain"}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                setQuery("");
                setDomain(null);
              }}
            >
              {query && domain ? "Clear filters" : "Clear filter"}
            </Button>
          </div>
        ) : (
          <CatalogTable rows={visible} sort={sort} onSort={toggleSort} />
        )}
      </div>
    </PageShell>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="resources" status={status} message={message} />;
}
