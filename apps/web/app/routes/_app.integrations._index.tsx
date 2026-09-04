import {
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
  useSearchParams,
} from "@remix-run/react";
import { useCallback, useId, useMemo, useState } from "react";
import { Search } from "~/components/icons";
import { CatalogActionsMenu } from "~/components/integrations/catalog-actions-menu";
import { InstallFromSource } from "~/components/integrations/install-from-source";
import { displayName, IntegrationCard } from "~/components/integrations/integration-card";
import { IntegrationPanel } from "~/components/integrations/integration-panel";
import { ErrorState } from "~/components/states";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { Segmented, SegmentedButton } from "~/components/ui/segmented";
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
      if (category && i.category !== category) return false;
      if (!needle) return true;
      // Slug included alongside the title: an operator who knows an integration as "github" should
      // not have to guess that it is listed as "GitHub".
      return [displayName(i), i.name, i.description, i.category]
        .filter((field): field is string => Boolean(field))
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [integrations, query, category]);

  // Three groups, in the order an operator needs them: what already works, what they can turn on
  // today, and what is only announced. Within a group the server's alphabetical order stands, so
  // cards do not move as connections change.
  const soon = visible.filter((i) => i.availability === "coming_soon");
  const ready = visible.filter((i) => i.availability !== "coming_soon");
  const connected = ready.filter((i) => i.status === "connected");
  const rest = ready.filter((i) => i.status !== "connected");

  return (
    <div className="flex flex-col gap-5">
      {/* One toolbar, not three stacked rows. A search field stretched the full width of a page
          holding five results announces itself as the main event; capped, it reads as the utility
          it is and lets the catalog be what the eye lands on. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative w-full sm:w-64">
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
            placeholder="Search integrations"
            className="pl-8"
          />
        </div>

        {categories.length > 0 && (
          <Segmented>
            <SegmentedButton selected={!category} onClick={() => setCategory(undefined)}>
              All
            </SegmentedButton>
            {categories.map((name) => (
              <SegmentedButton
                key={name}
                className="capitalize"
                selected={category === name}
                onClick={() => setCategory(category === name ? undefined : name)}
              >
                {name}
              </SegmentedButton>
            ))}
          </Segmented>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <InstallFromSource onInstalled={() => revalidator.revalidate()} />
          <CatalogActionsMenu />
        </div>
      </div>

      {updateError && (
        <p className="rounded-sm border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {updateError}
        </p>
      )}

      {visible.length === 0 ? (
        <Panel>
          <PanelEmpty>
            {integrations.length === 0
              ? "No integrations are available yet. Install one from a git repository to get started."
              : "Nothing matches that search."}
          </PanelEmpty>
        </Panel>
      ) : (
        <>
          {connected.length > 0 && (
            <Group
              title="Connected"
              items={connected}
              onUpdate={handleUpdate}
              updatingName={updatingName}
              isAdmin={isAdmin}
            />
          )}
          {rest.length > 0 && (
            <Group
              title={connected.length > 0 ? "Available" : "All integrations"}
              items={rest}
              onUpdate={handleUpdate}
              updatingName={updatingName}
              isAdmin={isAdmin}
            />
          )}
          {soon.length > 0 && (
            <Group
              title="Coming soon"
              description="Listed so the roadmap is visible. There is nothing to connect yet."
              items={soon}
              onUpdate={handleUpdate}
              updatingName={updatingName}
              isAdmin={isAdmin}
            />
          )}
        </>
      )}

      <IntegrationPanel name={viewing} onClose={closePanel} />
    </div>
  );
}

/**
 * A named group of cards. Deliberately not a `Panel`: a bordered container around bordered cards
 * frames the same content twice, so the heading names the group and the cards carry the only edge.
 */
function Group({
  title,
  description,
  items,
  onUpdate,
  updatingName,
  isAdmin,
}: {
  title: string;
  description?: string;
  items: IntegrationSummary[];
  onUpdate: (name: string, source?: string) => void;
  updatingName?: string;
  isAdmin: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        <Badge>{items.length}</Badge>
        {description ? (
          <p className="hidden text-xs text-muted-foreground sm:block">{description}</p>
        ) : null}
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
