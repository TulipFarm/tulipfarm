import {
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { CheckCircle2, Plug, Search } from "~/components/icons";
import { displayName, IntegrationCard } from "~/components/integrations/integration-card";
import { IntegrationOverview } from "~/components/integrations/integration-overview";
import { IntegrationPanel } from "~/components/integrations/integration-panel";
import { ErrorState } from "~/components/states";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import { type IntegrationSummary, listIntegrations, updateIntegration } from "~/lib/integrations";
import { useIsAdmin } from "~/lib/use-session-user";

/* Connection state is a card property; install is only for curated entries not yet cloned. */

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
  const [scope, setScope] = useState<"all" | "connected">("all");
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
      if (category && i.category !== category) return false;
      if (!needle) return true;
      // Slug included alongside the title: an operator who knows an integration as "github" should
      // not have to guess that it is listed as "GitHub".
      return [displayName(i), i.name, i.description, i.category]
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [integrations, query, category, scope]);

  const groups = useMemo(() => {
    const grouped = new Map<string, IntegrationSummary[]>();
    for (const integration of visible) {
      const key = integration.category ?? "Other";
      grouped.set(key, [...(grouped.get(key) ?? []), integration]);
    }
    return [...grouped.entries()];
  }, [visible]);

  return (
    <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10">
      <aside>
        <div className="sticky top-0 flex flex-col gap-5">
          <div className="relative">
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
              placeholder="Search"
              className="pl-8"
            />
          </div>

          <nav aria-label="Integration filters" className="flex flex-col gap-1">
            <FilterButton
              selected={scope === "all" && !category}
              onClick={() => {
                setScope("all");
                setCategory(undefined);
              }}
              icon={<Plug aria-hidden className="size-4" />}
            >
              All
            </FilterButton>
            <FilterButton
              selected={scope === "connected" && !category}
              onClick={() => {
                setScope("connected");
                setCategory(undefined);
              }}
              icon={<CheckCircle2 aria-hidden className="size-4" />}
            >
              Connected
            </FilterButton>

            {categories.length > 0 ? (
              <div className="mt-4 flex flex-col gap-1">
                <p className="mb-2 px-2 text-xs text-muted-foreground">Categories</p>
                {categories.map((name) => (
                  <FilterButton
                    key={name}
                    selected={scope === "all" && category === name}
                    onClick={() => {
                      setScope("all");
                      setCategory(name);
                    }}
                  >
                    <span className="capitalize">{name}</span>
                  </FilterButton>
                ))}
              </div>
            ) : null}
          </nav>
        </div>
      </aside>

      <div className="min-w-0">
        <IntegrationOverview integrations={integrations} />

        {updateError && (
          <p className="mt-5 rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {updateError}
          </p>
        )}

        <div className="mt-8">
          {visible.length === 0 ? (
            <Panel>
              <PanelEmpty>
                {integrations.length === 0
                  ? "No integrations are available yet. Install one from a git repository to get started."
                  : "Nothing matches that search."}
              </PanelEmpty>
            </Panel>
          ) : (
            <div className="flex flex-col gap-8">
              {groups.map(([title, items]) => (
                <Group
                  key={title}
                  title={categoryLabel(title)}
                  items={items}
                  onUpdate={handleUpdate}
                  updatingName={updatingName}
                  isAdmin={isAdmin}
                />
              ))}
            </div>
          )}
        </div>

        <IntegrationPanel name={viewing} onClose={closePanel} />
      </div>
    </div>
  );
}

function FilterButton({
  selected,
  onClick,
  icon,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
        selected
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function categoryLabel(category: string): string {
  return category.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * A named group of cards. Deliberately not a `Panel`: a bordered container around bordered cards
 * frames the same content twice, so the heading names the group and the cards carry the only edge.
 */
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
