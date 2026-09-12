import { StatusBadge, type StatusTone } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import type { IntegrationSummary, McpConnectionStatus } from "~/lib/integrations";
import { IntegrationIcon } from "./integration-icon";

/** Uncurated entries carry no registry title, so the slug is the honest display name. */
export function displayName(integration: IntegrationSummary): string {
  return integration.title ?? integration.name;
}

export function providerHost(integration: IntegrationSummary): string | undefined {
  if (!integration.homepage) return undefined;
  try {
    return new URL(integration.homepage).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export const CONNECTION: Record<McpConnectionStatus, { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "success" },
  connecting: { label: "Connecting", tone: "info" },
  error: { label: "Error", tone: "danger" },
  disconnected: { label: "Not connected", tone: "neutral" },
};

export function IntegrationCard({
  integration,
  onUpdate,
  updating,
  isAdmin,
}: {
  integration: IntegrationSummary;
  onUpdate: (name: string, source?: string) => void;
  updating?: boolean;
  isAdmin?: boolean;
}) {
  const name = displayName(integration);
  const soon = integration.availability === "coming_soon";

  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <IntegrationIcon
        label={name}
        iconSlug={integration.iconSlug}
        iconPath={integration.iconPath}
        iconColor={integration.iconColor}
        size="lg"
      />
      <div className="min-w-0">
        <h3 className="truncate text-base font-semibold text-foreground">{name}</h3>
        <p
          className="mt-0.5 truncate text-sm text-muted-foreground"
          title={integration.description}
        >
          {integration.description || "No description provided."}
        </p>
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-auto">
        {soon ? (
          <StatusBadge label="Coming soon" tone="neutral" />
        ) : !integration.installed ? (
          <StatusBadge label="Not installed" tone="neutral" />
        ) : (
          <StatusBadge {...CONNECTION[integration.status]} />
        )}
        {integration.updateAvailable && isAdmin ? <Badge>Update available</Badge> : null}
        {!soon && integration.installed ? (
          <>
            <Button asChild size="sm" variant="outline">
              <Link
                to={`?view=${encodeURIComponent(integration.name)}`}
                preventScrollReset
                aria-label={`View details for ${name}`}
              >
                View details
              </Link>
            </Button>
            {integration.updateAvailable && isAdmin ? (
              <Button
                size="sm"
                variant="outline"
                disabled={updating}
                aria-label={`Update ${name}`}
                onClick={() => onUpdate(integration.name, integration.source)}
              >
                {updating ? "Updating…" : "Update"}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}
