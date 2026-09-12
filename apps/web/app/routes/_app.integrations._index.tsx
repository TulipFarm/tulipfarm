import {
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { EmptyState } from "~/components/empty-state";
import { Search } from "~/components/icons";
import { displayName, IntegrationCard } from "~/components/integrations/integration-card";
import { IntegrationOverview } from "~/components/integrations/integration-overview";
import { IntegrationPanel } from "~/components/integrations/integration-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { type IntegrationSummary, listIntegrations, updateIntegration } from "~/lib/integrations";
import { useIsAdmin } from "~/lib/use-session-user";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

export async function clientLoader() {
  return { integrations: await listIntegrations() };
}

export default function IntegrationsIndex() {
  const { integrations } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  // The open preview lives in the URL, so Back closes it and a link to it can be shared.
  const [searchParams, setSearchParams] = useSearchParams();
  const viewing = searchParams.get("view") ?? undefined;
  const closePanel = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("view");
        return next;
      },
      { replace: true, preventScrollReset: true }
    );
  }, [setSearchParams]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const [scope, setScope] = useState<"all" | "connected" | "available">("all");
  const searchId = useId();
  const isAdmin = useIsAdmin();
  const [updatingName, setUpdatingName] = useState<string>();
  const [updateError, setUpdateError] = useState<string>();

  async function handleUpdate(name: string, source?: string) {
    setUpdatingName(name);
    setUpdateError(undefined);
    try {
      await updateIntegration(name, source);
      revalidator.revalidate();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setUpdatingName(undefined);
    }
  }

  const categories = useMemo(() => {
    const found = integrations.map((i) => i.category).filter((c): c is string => Boolean(c));
    return [...new Set(found)].sort();
  }, [integrations]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return integrations.filter((i) => {
      if (scope === "connected" && i.status !== "connected") return false;
      if (scope === "available" && (i.availability === "coming_soon" || i.status === "connected"))
        return false;
      if (category && i.category !== category) return false;
      if (!needle) return true;
      return [displayName(i), i.name, i.description, i.category]
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [integrations, query, category, scope]);

  const groups = useMemo(() => {
    const grouped = new Map<string, IntegrationSummary[]>();
    for (const integration of visible) {
      const key =
        integration.availability === "coming_soon"
          ? "Coming soon"
          : integration.status === "connected"
            ? "Connected"
            : "Available";
      grouped.set(key, [...(grouped.get(key) ?? []), integration]);
    }
    return ["Connected", "Available", "Coming soon"].flatMap((title) => {
      const items = grouped.get(title);
      return items
        ? [
            [
              title,
              items.sort((left, right) => displayName(left).localeCompare(displayName(right))),
            ] as const,
          ]
        : [];
    });
  }, [visible]);

  function clearFilters() {
    setQuery("");
    setScope("all");
    setCategory(undefined);
  }

  const filtered = Boolean(query.trim() || category || scope !== "all");
  const emptyConnected = scope === "connected" && !query.trim() && !category;

  return (
    <div
      className={
        integrations.length > 0
          ? "grid min-w-0 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-x-10"
          : "flex min-w-0 flex-col gap-6"
      }
    >
      <div className="min-w-0 lg:col-start-2">
        <IntegrationOverview integrations={integrations} />
      </div>
      {integrations.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-0 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:self-start">
          <div className="flex flex-col gap-3">
            <div className="relative w-full sm:max-w-sm">
              <label className="sr-only" htmlFor={searchId}>
                Search integrations
              </label>
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search providers"
                className="pl-8"
              />
            </div>

            <nav aria-label="Integration filters" className="flex flex-wrap gap-1 lg:flex-col">
              <FilterButton selected={scope === "all"} onClick={clearFilters}>
                All
              </FilterButton>
              <FilterButton selected={scope === "connected"} onClick={() => setScope("connected")}>
                Connected
              </FilterButton>
              <FilterButton selected={scope === "available"} onClick={() => setScope("available")}>
                Available
              </FilterButton>
            </nav>
          </div>
          {categories.length > 0 ? (
            <nav aria-label="Integration categories" className="flex flex-wrap gap-1 lg:flex-col">
              <FilterButton selected={!category} onClick={() => setCategory(undefined)}>
                All categories
              </FilterButton>
              {categories.map((name) => (
                <FilterButton
                  key={name}
                  selected={category === name}
                  onClick={() => setCategory(name)}
                >
                  <span className="capitalize">{name}</span>
                </FilterButton>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-6 lg:col-start-2">
        {updateError && (
          <p
            role="alert"
            className="rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {updateError}
          </p>
        )}

        <p role="status" className={filtered ? "text-xs text-muted-foreground" : "sr-only"}>
          {filtered
            ? `${visible.length} integration${visible.length === 1 ? " matches" : "s match"}`
            : ""}
        </p>
        {integrations.length === 0 ? (
          <EmptyState
            section="Integrations"
            title="No integrations available"
            hint="Ask in chat for help adding the service your agents need."
          >
            <Button asChild>
              <Link to="/?draft=Help%20me%20add%20an%20integration%20for%20the%20service%20I%20use.">
                Ask in chat
              </Link>
            </Button>
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState
            section="Integration results"
            title={emptyConnected ? "No connected integrations" : "Nothing matches that search"}
            hint={
              emptyConnected
                ? "Choose an available provider to review its access and setup."
                : "Try a different provider name or clear the filters."
            }
          >
            <Button
              variant="outline"
              onClick={() => {
                clearFilters();
                if (emptyConnected) setScope("available");
              }}
            >
              {emptyConnected ? "Browse available" : "Clear filters"}
            </Button>
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-8">
            {groups.map(([title, items]) => (
              <Group
                key={title}
                title={title}
                items={items}
                onUpdate={handleUpdate}
                updatingName={updatingName}
                isAdmin={isAdmin}
              />
            ))}
          </div>
        )}
        <IntegrationPanel name={viewing} onClose={closePanel} />
      </div>
    </div>
  );
}

function FilterButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`inline-flex min-h-11 max-w-full items-center break-words rounded-md px-2.5 py-1 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:bg-accent sm:min-h-7 ${
        selected
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Group({
  title,
  items,
  onUpdate,
  updatingName,
  isAdmin,
}: {
  title: string;
  items: IntegrationSummary[];
  onUpdate: (name: string, source?: string) => void;
  updatingName?: string;
  isAdmin: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-2 text-sm font-medium text-muted-foreground">
        {title}
      </h2>
      <ul className="divide-y divide-border">
        {items.map((integration) => (
          <IntegrationCard
            key={integration.name}
            integration={integration}
            onUpdate={onUpdate}
            updating={updatingName === integration.name}
            isAdmin={isAdmin}
          />
        ))}
      </ul>
    </section>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="integrations" status={status} message={message} />;
}
