import {
  Link,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { ChevronRight, Search } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { InstallFromSource } from "~/components/integrations/install-from-source";
import { IntegrationIcon } from "~/components/integrations/integration-icon";
import { ErrorState } from "~/components/states";
import { StatusBadge } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { ApiError } from "~/lib/api";
import { type IntegrationSummary, listIntegrations } from "~/lib/integrations";
import { cn } from "~/lib/utils";

/* Connection state is a row property; install is only for curated entries not yet cloned. */

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

export async function clientLoader() {
  return { integrations: await listIntegrations() };
}

/** Uncurated entries carry no registry title, so the slug is the honest display name. */
function displayName(integration: IntegrationSummary): string {
  return integration.title ?? integration.name;
}

export default function IntegrationsIndex() {
  const { integrations } = useLoaderData<typeof clientLoader>();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const searchId = useId();

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

  // Connected first: it is the smaller group and the one an operator returns to check on. Within a
  // group the server's alphabetical order stands, so rows do not move as connections change.
  const connected = visible.filter((i) => i.status === "connected");
  const rest = visible.filter((i) => i.status !== "connected");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
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
          <InstallFromSource onInstalled={() => revalidator.revalidate()} />
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <CategoryChip active={!category} onClick={() => setCategory(undefined)}>
              All
            </CategoryChip>
            {categories.map((name) => (
              <CategoryChip
                key={name}
                active={category === name}
                onClick={() => setCategory(category === name ? undefined : name)}
              >
                {name}
              </CategoryChip>
            ))}
          </div>
        )}
      </div>

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
          {connected.length > 0 && <Section title="Connected" items={connected} />}
          {rest.length > 0 && (
            <Section title={connected.length > 0 ? "Available" : "All integrations"} items={rest} />
          )}
        </>
      )}
    </div>
  );
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-sm border px-2 py-1 text-xs capitalize transition-colors",
        active
          ? "border-border bg-muted text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Section({ title, items }: { title: string; items: IntegrationSummary[] }) {
  return (
    <Panel title={title} actions={<Badge>{items.length}</Badge>} flush>
      <ul className="flex flex-col divide-y divide-border">
        {items.map((integration) => (
          <IntegrationRow key={integration.name} integration={integration} />
        ))}
      </ul>
    </Panel>
  );
}

function RowBody({ integration }: { integration: IntegrationSummary }) {
  const name = displayName(integration);
  return (
    <>
      <IntegrationIcon
        label={name}
        iconPath={integration.iconPath}
        iconColor={integration.iconColor}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">{name}</span>
          {integration.category && (
            <Badge className="hidden capitalize sm:inline-flex">{integration.category}</Badge>
          )}
        </span>
        {integration.description && (
          <span className="line-clamp-1 text-xs text-muted-foreground">
            {integration.description}
          </span>
        )}
      </span>
    </>
  );
}

function IntegrationRow({ integration }: { integration: IntegrationSummary }) {
  // A curated entry that has not been cloned has no detail page to open — linking there would 404.
  // It is a row about a repository, not about an integration this deployment has.
  if (!integration.installed) {
    return (
      <li className="flex items-center gap-3 px-4 py-3">
        <RowBody integration={integration} />
        <span className="shrink-0 text-xs text-muted-foreground">Not installed</span>
      </li>
    );
  }

  return (
    <li className="flex flex-col">
      {/* The row is the link. A catalog is scanned and clicked, so the target should be the row
          the pointer is already over, not the few characters of its title. */}
      <Link
        to={`/integrations/${encodeURIComponent(integration.name)}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
      >
        <RowBody integration={integration} />
        <span className="flex shrink-0 items-center gap-2">
          {integration.status === "connected" ? (
            <StatusBadge label="connected" tone="success" />
          ) : (
            <span className="text-xs text-muted-foreground">Set up</span>
          )}
          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
        </span>
      </Link>
      {integration.errorMessage && (
        <p className="px-4 pb-2 text-xs text-destructive">{integration.errorMessage}</p>
      )}
    </li>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="integrations" status={status} message={message} />;
}
