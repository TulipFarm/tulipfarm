import type { McpIntegrationDefinition, McpServerDefinition } from "@tulipfarm/schema";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import type { McpCatalogEntry } from "~/lib/mcp-integrations";
import { IntegrationIcon } from "./integration-icon";

export function McpCatalog({
  entries,
  configuredServers,
  isAdmin,
  onSetup,
}: {
  entries: McpCatalogEntry[];
  configuredServers: readonly McpIntegrationDefinition[];
  isAdmin: boolean;
  onSetup: (entry: McpCatalogEntry, localPreset?: McpServerDefinition) => void;
}) {
  return (
    <section aria-labelledby="official-mcp-heading">
      <h2 id="official-mcp-heading" className="mb-2 text-sm font-medium text-muted-foreground">
        Official MCP servers
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Published by the named provider. Listing does not grant trust, prove live compatibility, or
        enable Knowledge sync. Connect and review the capabilities each server actually exposes.
      </p>
      <ul className="divide-y divide-border">
        {entries.map((entry) => {
          const configured = configuredServers.find(
            ({ server }) =>
              server.transport.type === "streamable-http" && server.transport.url === entry.url
          );
          const localPreset = entry.localPreset;
          const configuredLocal = localPreset
            ? configuredServers.find(({ server }) => server.id === localPreset.id)
            : undefined;
          return (
            <li key={entry.id} className="space-y-3 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <IntegrationIcon label={entry.name} iconSlug={entry.id} size="lg" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold">{entry.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    Published by {entry.publisher} ·{" "}
                    {entry.authentication
                      .map((method) => (method === "oauth" ? "Browser sign-in" : "Token"))
                      .join(" / ")}
                  </p>
                </div>
                {configured ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/integrations/${encodeURIComponent(configured.server.id)}`}>
                      Manage {entry.name}
                    </Link>
                  </Button>
                ) : isAdmin ? (
                  <Button size="sm" variant="outline" onClick={() => onSetup(entry)}>
                    Set up {entry.name}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    An admin can add this server
                  </span>
                )}
              </div>
              {localPreset && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {localPreset.label}: explicit personal GitHub .md/.txt branch files only. Shared
                    token accounts and remote GitHub are not eligible for Knowledge sync. Setup
                    starts disabled and grants no capability approval or account access.
                  </p>
                  {configuredLocal ? (
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/integrations/${encodeURIComponent(configuredLocal.server.id)}`}>
                        Manage {localPreset.label}
                      </Link>
                    </Button>
                  ) : isAdmin ? (
                    <Button size="sm" variant="outline" onClick={() => onSetup(entry, localPreset)}>
                      Set up {localPreset.label}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      An admin can add {localPreset.label}
                    </span>
                  )}
                </div>
              )}
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Setup and compatibility</summary>
                <div className="mt-2 space-y-2">
                  <p className="break-all">{entry.url}</p>
                  <ol className="list-inside list-decimal space-y-1">
                    {entry.setup.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <ul className="list-inside list-disc space-y-1">
                    {entry.limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                  <p>
                    {entry.knowledgeSync === "excluded"
                      ? "Knowledge sync is excluded for this provider."
                      : "Knowledge sync requires a supported, reviewed source adapter; connecting alone does not copy content."}
                  </p>
                  <a
                    href={entry.publisherEvidence}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand hover:underline"
                  >
                    Official provider documentation
                  </a>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
