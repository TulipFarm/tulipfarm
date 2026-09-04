import { Check } from "~/components/icons";
import type { StatusTone } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { Link } from "~/components/ui/link";
import type { IntegrationSummary, McpConnectionStatus } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { IntegrationIcon } from "./integration-icon";

const SHORT_DESCRIPTIONS: Record<string, string> = {
  github: "Browse repositories and review pull requests",
  slack: "Send messages and read channels",
  jira: "Track issues and delivery work",
  linear: "Track issues and plan cycles",
  google: "Work across Gmail, Drive, Calendar, and Docs",
  googleworkspace: "Work across Gmail, Drive, Calendar, and Docs",
};

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

function shortDescription(integration: IntegrationSummary): string {
  const curated = SHORT_DESCRIPTIONS[integration.name.toLowerCase()];
  if (curated) return curated;
  if (!integration.description) return "Use this tool in agent workflows";
  return integration.description.split(/[.—]/, 1)[0].trim();
}

function StatusAction({ integration }: { integration: IntegrationSummary }) {
  const name = displayName(integration);

  if (integration.availability === "coming_soon") {
    return (
      <span className="rounded-lg bg-muted px-3 py-1.5 text-sm text-muted-foreground">
        Coming soon
      </span>
    );
  }

  if (!integration.installed) {
    return (
      <span className="rounded-lg bg-muted px-3 py-1.5 text-sm text-muted-foreground">
        Not installed
      </span>
    );
  }

  const connected = integration.status === "connected";
  return (
    <Link
      to={`?view=${encodeURIComponent(integration.name)}`}
      preventScrollReset
      aria-label={`View details for ${name}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
        "transition-[background-color,transform] active:scale-[0.98]",
        connected
          ? "bg-muted text-foreground hover:bg-accent"
          : "border border-border bg-background text-foreground hover:bg-accent"
      )}
    >
      {connected ? <Check aria-hidden className="size-3.5" /> : null}
      {connected
        ? "Connected"
        : integration.status === "connecting"
          ? "Connecting"
          : integration.status === "error"
            ? "Try again"
            : "Connect"}
    </Link>
  );
}

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

  return (
    <li className="flex min-w-0 items-center gap-4 py-4">
      <IntegrationIcon
        label={name}
        iconSlug={integration.iconSlug}
        iconPath={integration.iconPath}
        iconColor={integration.iconColor}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-semibold text-foreground">{name}</h3>
        <p className="truncate text-base text-muted-foreground">{shortDescription(integration)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
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
        <StatusAction integration={integration} />
      </div>
    </li>
  );
}
