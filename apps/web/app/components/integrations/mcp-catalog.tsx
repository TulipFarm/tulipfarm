import type { McpIntegrationDefinition } from "@tulipfarm/schema";
import { Button } from "~/components/ui/button";
import type { McpCatalogEntry } from "~/lib/mcp-integrations";
import { IntegrationIcon } from "./integration-icon";
import { type McpConnectionData, mcpConnectionState } from "./mcp-connection-state";
import { providerGuide } from "./provider-guide";

export function McpCatalog({
  entries,
  configuredServers,
  isAdmin,
  onSetup,
  onManage,
  connections = {},
  onRetry,
}: {
  entries: McpCatalogEntry[];
  configuredServers: readonly McpIntegrationDefinition[];
  isAdmin: boolean;
  onSetup: (entry: McpCatalogEntry) => void;
  onManage: (definition: McpIntegrationDefinition, entry: McpCatalogEntry) => void;
  connections?: Record<string, McpConnectionData>;
  onRetry?: () => void;
}) {
  return (
    <section aria-labelledby="integrations-catalog-heading">
      <h2 id="integrations-catalog-heading" className="text-base font-semibold">
        Integrations
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        Choose an app to connect or manage its access.
      </p>
      {entries.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground">No integrations match this search.</p>
      )}
      <ul className="grid gap-x-10 xl:grid-cols-2">
        {entries.map((entry) => {
          const configured = configuredServers.find(
            ({ server }) =>
              server.transport.type === "streamable-http" && server.transport.url === entry.url
          );
          const state = configured
            ? mcpConnectionState(connections[configured.server.id])
            : undefined;
          return (
            <li
              key={entry.id}
              className="flex min-w-0 items-center gap-3 border-b border-border py-5"
            >
              <IntegrationIcon label={entry.name} iconSlug={entry.id} size="lg" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">{entry.name}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {providerGuide(entry.id)?.description ?? `Tools from ${entry.publisher}.`}
                </p>
                {!configured && !isAdmin && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    An admin needs to finish setup.
                  </p>
                )}
                {state && (
                  <p
                    className="mt-1 text-xs text-muted-foreground"
                    role={state.action === "Retry" ? "alert" : undefined}
                  >
                    {connections[configured?.server.id ?? ""]?.error ?? state.description}
                  </p>
                )}
              </div>
              {configured ? (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`${state?.action} ${entry.name}`}
                  onClick={() =>
                    state?.action === "Retry" ? onRetry?.() : onManage(configured, entry)
                  }
                >
                  {state?.action}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Connect ${entry.name}`}
                  onClick={() => onSetup(entry)}
                >
                  Connect
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
