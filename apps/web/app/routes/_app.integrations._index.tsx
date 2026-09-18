import {
  type MetaFunction,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import type { McpIntegrationDefinition, McpServerDefinition } from "@tulipfarm/schema";
import { useId, useState } from "react";
import { EmptyState } from "~/components/empty-state";
import { IntegrationIcon } from "~/components/integrations/integration-icon";
import { IntegrationOverview } from "~/components/integrations/integration-overview";
import { McpCatalog } from "~/components/integrations/mcp-catalog";
import { McpServerForm } from "~/components/integrations/mcp-server-form";
import { ErrorState } from "~/components/states";
import { StatusBadge } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { Modal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import { getIntegration, type IntegrationDetail } from "~/lib/integrations";
import { listMcpCatalog, listMcpIntegrations, type McpCatalogEntry } from "~/lib/mcp-integrations";
import { useIsAdmin } from "~/lib/use-session-user";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

type IntegrationsIndexData = {
  servers: McpIntegrationDefinition[];
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
        error: error instanceof Error ? error.message : "The official catalog could not be loaded.",
      })),
  ]);
  return { servers, channels, catalog };
}

export default function IntegrationsIndex() {
  const { servers, channels, catalog } = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const isAdmin = useIsAdmin();
  const [adding, setAdding] = useState(false);
  const [suggestion, setSuggestion] = useState<McpCatalogEntry>();
  const [localPreset, setLocalPreset] = useState<McpServerDefinition>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "enabled" | "disabled">("all");
  const searchId = useId();
  const needle = query.trim().toLowerCase();
  const visible = servers.filter(
    (definition) =>
      (scope === "all" || definition.enabled === (scope === "enabled")) &&
      (!needle ||
        `${definition.server.id} ${definition.server.label}`.toLowerCase().includes(needle))
  );
  const native = channels.filter((channel) => !needle || channel.name.includes(needle));
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-x-10">
      <div className="min-w-0 lg:col-start-2">
        <IntegrationOverview
          integrations={channels.flatMap((channel) =>
            channel.integration ? [channel.integration] : []
          )}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Add MCP servers for Agent Tools, resources and prompts. Connect native channels
            separately.
          </p>
          {isAdmin && (
            <Button
              onClick={() => {
                setSuggestion(undefined);
                setLocalPreset(undefined);
                setAdding(true);
              }}
            >
              Add MCP server
            </Button>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1">
        <label htmlFor={searchId} className="sr-only">
          Search integrations
        </label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search integrations"
        />
        <nav aria-label="MCP server filters" className="flex flex-wrap gap-1 lg:flex-col">
          {(["all", "enabled", "disabled"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={`rounded-md px-2.5 py-1 text-left text-sm capitalize ${scope === value ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
            >
              {value}
            </button>
          ))}
        </nav>
      </div>
      <div className="min-w-0 space-y-8 lg:col-start-2">
        <section aria-labelledby="mcp-servers-heading">
          <h2 id="mcp-servers-heading" className="mb-2 text-sm font-medium text-muted-foreground">
            MCP servers
          </h2>
          {visible.length === 0 ? (
            <EmptyState
              section="MCP servers"
              title={
                servers.length === 0 ? "No MCP servers configured" : "Nothing matches that search"
              }
              hint={
                servers.length === 0
                  ? "An admin can add an official server or configure another approved remote or isolated local server."
                  : "Try a different name or clear the filters."
              }
            >
              {servers.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setScope("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((definition) => (
                <li key={definition.server.id} className="flex flex-wrap items-center gap-3 py-4">
                  <IntegrationIcon label={definition.server.label} size="lg" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold">{definition.server.label}</h3>
                    <p className="break-all text-xs text-muted-foreground">
                      {definition.server.transport.type === "streamable-http"
                        ? definition.server.transport.url
                        : "Local isolated server"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {definition.reviewed.tools.length} Tools ·{" "}
                      {definition.reviewed.resources.length} resources ·{" "}
                      {definition.reviewed.prompts.length} prompts approved
                    </p>
                  </div>
                  <StatusBadge
                    label={definition.enabled ? "Enabled" : "Disabled"}
                    tone={definition.enabled ? "success" : "neutral"}
                  />
                  <Button asChild size="sm" variant="outline">
                    <Link
                      to={`/integrations/${encodeURIComponent(definition.server.id)}`}
                      aria-label={`Manage ${definition.server.label}`}
                    >
                      Manage
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="native-channels-heading">
          <h2
            id="native-channels-heading"
            className="mb-2 text-sm font-medium text-muted-foreground"
          >
            Native channels
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Slack and GitHub events and replies use native channels. These do not enable MCP
            business actions or Knowledge sync.
          </p>
          <ul className="divide-y divide-border">
            {native.map((channel) => (
              <li key={channel.name} className="flex flex-wrap items-center gap-3 py-4">
                <IntegrationIcon
                  label={channel.name === "github" ? "GitHub" : "Slack"}
                  iconSlug={channel.name}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold">
                    {channel.name === "github" ? "GitHub" : "Slack"}
                  </h3>
                  {channel.error && (
                    <p role="alert" className="text-xs text-destructive">
                      {channel.error}
                    </p>
                  )}
                </div>
                {channel.integration ? (
                  <>
                    <StatusBadge
                      label={
                        channel.integration.connected ? "Credentials connected" : "Not connected"
                      }
                      tone={channel.integration.connected ? "success" : "neutral"}
                    />
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/integrations/${channel.name}?channel=1`}>Manage channel</Link>
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => revalidator.revalidate()}>
                    Retry channel status
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
        {catalog.error ? (
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Official MCP servers</h2>
            <p role="alert" className="text-sm text-destructive">
              {catalog.error}
            </p>
            <Button variant="outline" onClick={() => revalidator.revalidate()}>
              Retry official catalog
            </Button>
          </section>
        ) : (
          <McpCatalog
            entries={catalog.entries.filter(
              (entry) =>
                !needle ||
                `${entry.id} ${entry.name} ${entry.publisher}`.toLowerCase().includes(needle)
            )}
            configuredServers={servers}
            isAdmin={isAdmin}
            onSetup={(entry, preset) => {
              setSuggestion(entry);
              setLocalPreset(preset);
              setAdding(true);
            }}
          />
        )}
      </div>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add MCP server"
        className="max-w-2xl"
      >
        <McpServerForm
          key={adding ? "open" : "closed"}
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
                  environment: localPreset?.authentication?.environment,
                  sharedAllowed: localPreset?.authentication?.sharedAllowed,
                }
              : undefined
          }
          onCancel={() => setAdding(false)}
          onSaved={(definition) => {
            setAdding(false);
            navigate(`/integrations/${encodeURIComponent(definition.server.id)}`);
          }}
        />
      </Modal>
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
