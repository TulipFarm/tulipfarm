import { type MetaFunction, useLoaderData, useRevalidator, useRouteError } from "@remix-run/react";
import type { McpIntegrationDefinition, McpServerDefinition } from "@tulipfarm/schema";
import { useId, useState } from "react";
import { ArrowUpRight, Plus, Search } from "~/components/icons";
import { IntegrationIcon } from "~/components/integrations/integration-icon";
import { IntegrationOverview } from "~/components/integrations/integration-overview";
import { IntegrationSetupGuide } from "~/components/integrations/integration-setup-guide";
import { McpCatalog } from "~/components/integrations/mcp-catalog";
import {
  loadMcpConnectionData,
  type McpConnectionData,
  mcpConnectionState,
} from "~/components/integrations/mcp-connection-state";
import { McpIntegrationPanel } from "~/components/integrations/mcp-integration-panel";
import { McpProviderSetup } from "~/components/integrations/mcp-provider-setup";
import { McpServerForm } from "~/components/integrations/mcp-server-form";
import { ErrorState } from "~/components/states";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Sheet } from "~/components/ui/sheet";
import { ApiError } from "~/lib/api";
import { getIntegration, type IntegrationDetail } from "~/lib/integrations";
import { listMcpCatalog, listMcpIntegrations, type McpCatalogEntry } from "~/lib/mcp-integrations";
import { useIsAdmin } from "~/lib/use-session-user";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

type IntegrationsIndexData = {
  servers: McpIntegrationDefinition[];
  connections: Record<string, McpConnectionData>;
  channels: {
    name: "slack" | "github";
    integration: IntegrationDetail | null;
    error: string | null;
  }[];
  catalog: { entries: McpCatalogEntry[]; error: string | null };
};

export async function clientLoader(): Promise<IntegrationsIndexData> {
  const [servers, channels, catalog] = await Promise.all([
    listMcpIntegrations(),
    Promise.all(
      (["slack", "github"] as const).map(async (name) => {
        try {
          return { name, integration: await getIntegration(name), error: null };
        } catch (error) {
          return {
            name,
            integration: null,
            error: error instanceof Error ? error.message : "Channel setup could not be loaded.",
          };
        }
      })
    ),
    listMcpCatalog()
      .then((entries) => ({ entries, error: null }))
      .catch((error: unknown) => ({
        entries: [],
        error:
          error instanceof Error ? error.message : "The integrations catalog could not be loaded.",
      })),
  ]);
  const connections = Object.fromEntries(
    await Promise.all(
      servers.map(
        async ({ server }) => [server.id, await loadMcpConnectionData(server.id)] as const
      )
    )
  );
  return { servers, channels, catalog, connections };
}

export default function IntegrationsIndex() {
  const {
    servers,
    channels,
    catalog,
    connections: loadedConnections,
  } = useLoaderData<typeof clientLoader>();
  const connections: Record<string, McpConnectionData> = loadedConnections ?? {};
  const revalidator = useRevalidator();
  const isAdmin = useIsAdmin();
  const [adding, setAdding] = useState(false);
  const [suggestion, setSuggestion] = useState<McpCatalogEntry>();
  const [localPreset, setLocalPreset] = useState<McpServerDefinition>();
  const [managing, setManaging] = useState<McpIntegrationDefinition>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "enabled" | "disabled">("all");
  const searchId = useId();
  const needle = query.trim().toLowerCase();
  const catalogServerIds = new Set(
    catalog.entries.flatMap((entry) => {
      const configured = servers.find(
        ({ server }) =>
          server.transport.type === "streamable-http" && server.transport.url === entry.url
      );
      return configured ? [configured.server.id] : [];
    })
  );
  const visible = servers.filter(
    (definition) =>
      !catalogServerIds.has(definition.server.id) &&
      (scope === "all" || definition.enabled === (scope === "enabled")) &&
      (!needle ||
        `${definition.server.id} ${definition.server.label}`.toLowerCase().includes(needle))
  );
  const visibleCatalog = catalog.entries.filter((entry) => {
    const configured = servers.find(
      ({ server }) =>
        server.transport.type === "streamable-http" && server.transport.url === entry.url
    );
    return (
      (!needle ||
        `${entry.id} ${entry.name} ${entry.publisher} ${configured?.server.label ?? ""} ${configured?.server.id ?? ""}`
          .toLowerCase()
          .includes(needle)) &&
      (scope === "all" || configured?.enabled === (scope === "enabled"))
    );
  });
  const native = channels.filter((channel) => !needle || channel.name.includes(needle));
  const managedDefinition = managing
    ? (servers.find(({ server }) => server.id === managing.server.id) ?? managing)
    : undefined;
  const suggestedDefinition = suggestion
    ? servers.find(
        ({ server }) =>
          server.transport.type === "streamable-http" && server.transport.url === suggestion.url
      )
    : undefined;
  const sheetDefinition = managedDefinition ?? suggestedDefinition;
  const connectionAction = sheetDefinition
    ? mcpConnectionState(connections[sheetDefinition.server.id]).action
    : "Connect";
  const sheetAction = connectionAction === "Retry" ? "Set up" : connectionAction;
  function closeSheet() {
    setAdding(false);
    setManaging(undefined);
    setSuggestion(undefined);
    setLocalPreset(undefined);
  }
  function openManagement(definition: McpIntegrationDefinition, entry?: McpCatalogEntry) {
    setManaging(definition);
    setSuggestion(entry);
    setLocalPreset(undefined);
    setAdding(true);
  }
  return (
    <div className="min-w-0 space-y-6" aria-busy={revalidator.state === "loading"}>
      {revalidator.state === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing integration accounts...
        </p>
      )}
      <IntegrationOverview
        integrations={channels.flatMap((channel) =>
          channel.integration ? [channel.integration] : []
        )}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-xs">
          <label htmlFor={searchId} className="sr-only">
            Search integrations
          </label>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search integrations"
            className="pl-8"
          />
        </div>
        {servers.length > 0 && (
          <nav aria-label="Integration filters" className="flex flex-wrap gap-1">
            {(["all", "enabled", "disabled"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
                className={`rounded-md px-2.5 py-1 text-xs capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${scope === value ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
              >
                {value}
              </button>
            ))}
          </nav>
        )}
        {(needle || scope !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setScope("all");
            }}
          >
            Clear filters
          </Button>
        )}
        {isAdmin && (
          <Button
            onClick={() => {
              setSuggestion(undefined);
              setLocalPreset(undefined);
              setManaging(undefined);
              setAdding(true);
            }}
          >
            <Plus className="size-4" />
            Add integration
          </Button>
        )}
      </div>
      <div className="min-w-0 space-y-8">
        {visible.length > 0 ? (
          <section aria-labelledby="mcp-servers-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="mcp-servers-heading" className="text-base font-semibold">
                Your integrations
              </h2>
            </div>
            <ul className="divide-y divide-border">
              {visible.map((definition) => {
                const state = mcpConnectionState(connections[definition.server.id]);
                return (
                  <li
                    key={definition.server.id}
                    className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 py-4 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto]"
                  >
                    <IntegrationIcon
                      label={definition.server.label}
                      iconSlug={
                        catalog.entries.find(
                          (entry) =>
                            definition.server.transport.type === "streamable-http" &&
                            definition.server.transport.url === entry.url
                        )?.id
                      }
                      size="lg"
                    />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">{definition.server.label}</h3>
                      <p className="text-xs text-muted-foreground">
                        {definition.server.transport.type === "streamable-http"
                          ? "Hosted by the provider"
                          : "Runs on your infrastructure"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {definition.reviewed.tools.length +
                          definition.reviewed.resources.length +
                          definition.reviewed.prompts.length >
                        0
                          ? "Access reviewed"
                          : "Finish setup to choose what agents can do"}
                      </p>
                    </div>
                    <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3">
                      <p
                        className="text-xs text-muted-foreground"
                        role={state.action === "Retry" ? "alert" : undefined}
                      >
                        {connections[definition.server.id]?.error ?? state.description}
                      </p>
                      <StatusBadge
                        label={definition.enabled ? "Enabled" : "Disabled"}
                        tone={definition.enabled ? "success" : "neutral"}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`${state.action} ${definition.server.label}`}
                        onClick={() =>
                          state.action === "Retry"
                            ? revalidator.revalidate()
                            : openManagement(definition)
                        }
                      >
                        {state.action}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : servers.length === 0 && !needle ? (
          <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">No integrations configured yet.</span>{" "}
            {isAdmin
              ? "Choose an integration below to get started, or add another provider."
              : "Ask an admin to add an integration to get started."}
          </p>
        ) : null}
        {catalog.error ? (
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Integrations</h2>
            <p role="alert" className="text-sm text-destructive">
              {catalog.error}
            </p>
            <Button variant="outline" onClick={() => revalidator.revalidate()}>
              Retry integrations catalog
            </Button>
          </section>
        ) : visibleCatalog.length > 0 || visible.length === 0 ? (
          <McpCatalog
            entries={visibleCatalog}
            configuredServers={servers}
            connections={connections}
            onRetry={() => revalidator.revalidate()}
            isAdmin={isAdmin}
            onSetup={(entry) => {
              setSuggestion(entry);
              setLocalPreset(undefined);
              setManaging(undefined);
              setAdding(true);
            }}
            onManage={openManagement}
          />
        ) : null}
        <section aria-labelledby="native-channels-heading">
          <h2 id="native-channels-heading" className="text-base font-semibold">
            Messages and events
          </h2>
          <p className="mt-1 mb-4 max-w-prose text-sm text-muted-foreground">
            Receive events and send replies in Slack and GitHub. Channel connections are separate
            from agent tools and Knowledge sync.
          </p>
          {native.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">No channels match this search.</p>
          )}
          <ul className="divide-y divide-border">
            {native.map((channel) => (
              <li
                key={channel.name}
                className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 py-4 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto]"
              >
                <IntegrationIcon
                  label={channel.name === "github" ? "GitHub" : "Slack"}
                  iconSlug={channel.name}
                  size="lg"
                />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">
                    {channel.name === "github" ? "GitHub" : "Slack"}
                  </h3>
                  {channel.error && (
                    <p role="alert" className="text-xs text-destructive">
                      {channel.error}
                    </p>
                  )}
                </div>
                <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3">
                  {channel.integration ? (
                    <>
                      <StatusBadge
                        label={
                          channel.integration.connected ? "Account connected" : "Not connected"
                        }
                        tone={channel.integration.connected ? "success" : "neutral"}
                      />
                      <Button asChild size="sm" variant="outline">
                        <Link
                          to={`/integrations/${channel.name}?channel=1`}
                          aria-label={`${channel.integration.connected ? "Manage" : "Connect"} ${channel.name === "github" ? "GitHub" : "Slack"} channel`}
                        >
                          {channel.integration.connected ? "Manage channel" : "Connect channel"}
                        </Link>
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => revalidator.revalidate()}>
                      Retry channel status
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <Sheet
        open={adding}
        onClose={closeSheet}
        title={
          managedDefinition
            ? `${sheetAction} ${managedDefinition.server.label}`
            : suggestion
              ? localPreset
                ? "Set up GitHub Knowledge"
                : `${sheetAction} ${suggestion.name}`
              : "Add integration"
        }
        className="max-w-2xl"
        headerActions={
          managedDefinition ? (
            <Button asChild size="sm" variant="ghost">
              <Link
                to={`/integrations/${encodeURIComponent(managedDefinition.server.id)}`}
                aria-label="Open integration page"
              >
                <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          ) : undefined
        }
      >
        {adding && (
          <div className="space-y-6">
            {!isAdmin && suggestion && !localPreset && !managedDefinition && (
              <IntegrationSetupGuide entry={suggestion} />
            )}
            {localPreset && (
              <div className="flex items-start gap-3">
                <IntegrationIcon label="GitHub" iconSlug="github" size="lg" />
                <div>
                  <h3 className="text-base font-semibold">GitHub Knowledge</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Copy selected .md and .txt files into your private Knowledge. Requires an
                    isolated runtime on your infrastructure and a personal GitHub token.
                  </p>
                </div>
              </div>
            )}
            {managedDefinition ? (
              <McpIntegrationPanel
                key={managedDefinition.server.id}
                serverId={managedDefinition.server.id}
                onDone={closeSheet}
                onChanged={() => revalidator.revalidate()}
                onRemoved={() => {
                  closeSheet();
                  revalidator.revalidate();
                }}
              />
            ) : isAdmin && suggestion && !localPreset ? (
              <McpProviderSetup
                key={suggestion.id}
                entry={suggestion}
                onDone={closeSheet}
                onChanged={() => revalidator.revalidate()}
              />
            ) : isAdmin ? (
              <McpServerForm
                key={`${suggestion?.id ?? "custom"}:${localPreset?.id ?? "hosted"}`}
                existingIds={servers.map((definition) => definition.server.id)}
                suggestion={
                  suggestion
                    ? {
                        id:
                          localPreset?.id ??
                          (suggestion.id === "slack" || suggestion.id === "github"
                            ? `${suggestion.id}-mcp`
                            : suggestion.id),
                        label: localPreset?.label ?? suggestion.name,
                        transport: localPreset?.transport ?? {
                          type: "streamable-http",
                          url: suggestion.url,
                        },
                        authentication:
                          localPreset?.authentication?.type ??
                          (suggestion.authentication.includes("token") ? "token" : "oauth"),
                        authenticationMethods: localPreset?.authentication
                          ? [localPreset.authentication.type]
                          : suggestion.authentication,
                        environment: localPreset?.authentication?.environment,
                        sharedAllowed: localPreset?.authentication?.sharedAllowed,
                      }
                    : undefined
                }
                onCancel={closeSheet}
                onSaved={(definition) => {
                  setManaging(definition);
                  revalidator.revalidate();
                }}
              />
            ) : (
              <p className="rounded-md bg-muted p-3 text-sm">
                Ask an admin to add this integration. Once it is available, you can connect your own
                account.
              </p>
            )}
            {suggestion?.localPreset && !localPreset && (
              <details className="border-t border-border pt-4 text-sm">
                <summary className="w-fit cursor-pointer font-medium">
                  Optional Knowledge sync
                </summary>
                <div className="mt-3 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Copy selected GitHub files into your private Knowledge. Shared accounts and the
                    hosted GitHub integration cannot be used for this sync. The local setup requires
                    an isolated runtime on your infrastructure.
                  </p>
                  {servers.some(({ server }) => server.id === suggestion.localPreset?.id) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const configured = servers.find(
                          ({ server }) => server.id === suggestion.localPreset?.id
                        );
                        if (configured) openManagement(configured);
                      }}
                    >
                      Manage Knowledge sync
                    </Button>
                  ) : isAdmin ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setManaging(undefined);
                        setLocalPreset(suggestion.localPreset);
                      }}
                    >
                      Set up GitHub Knowledge (local)
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Ask an admin to set up Knowledge sync.
                    </p>
                  )}
                </div>
              </details>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <ErrorState
      section="integrations"
      status={error instanceof ApiError ? error.status : undefined}
      message={error instanceof Error ? error.message : undefined}
    />
  );
}
