import { Link } from "@remix-run/react";
import { ChevronRight } from "lucide-react";
import { StatusBadge, type StatusTone } from "~/components/status-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { IntegrationSummary, McpConnectionStatus } from "~/lib/integrations";
import { cn } from "~/lib/utils";
import { IntegrationIcon } from "./integration-icon";

// Grid rather than list: see DESIGN.md, "The integrations catalog".

/** Uncurated entries carry no registry title, so the slug is the honest display name. */
export function displayName(integration: IntegrationSummary): string {
  return integration.title ?? integration.name;
}

/**
 * Who publishes it, in the form an operator will recognise. The homepage host is the honest
 * answer: `maintainer` is an author of the manifest, not the provider behind the brand.
 */
export function providerHost(integration: IntegrationSummary): string | undefined {
  if (!integration.homepage) return undefined;
  try {
    return new URL(integration.homepage).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function Frame({ muted, children }: { muted?: boolean; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border border-border bg-card",
        "transition-[border-color,box-shadow] duration-150",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
        muted
          ? "bg-muted/20"
          : "hover:border-foreground/20 hover:shadow-[0_1px_3px_rgb(0_0_0/0.06)]"
      )}
    >
      {children}
    </li>
  );
}

function Head({ integration }: { integration: IntegrationSummary }) {
  const name = displayName(integration);
  const by = providerHost(integration);
  // Falls back to the slug only when the title is not already it — repeating the heading one line
  // below it says nothing, and an uncurated entry has nothing else to say.
  const secondary = by ? `By ${by}` : name === integration.name ? undefined : integration.name;
  return (
    <div className="flex items-start gap-3">
      <IntegrationIcon
        label={name}
        iconSlug={integration.iconSlug}
        iconPath={integration.iconPath}
        iconColor={integration.iconColor}
        size="lg"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold leading-tight text-foreground">{name}</h3>
        {secondary ? (
          <p className="mt-0.5 truncate text-[13px] leading-tight text-muted-foreground">
            {secondary}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A fact about the integration, sized to read as metadata rather than as content. */
function Meta({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
      {children}
    </span>
  );
}

function Body({ integration }: { integration: IntegrationSummary }) {
  const steps = integration.setupSteps;
  return (
    <div className="flex flex-1 flex-col gap-2.5 p-4">
      {/* Connection state is stated once, in the footer, where it lines up across the grid. */}
      <Head integration={integration} />
      <p
        className={cn(
          "line-clamp-2 text-[13px] leading-[1.5]",
          integration.description ? "text-muted-foreground" : "text-muted-foreground/70"
        )}
      >
        {integration.description ?? "No description declared."}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
        {integration.category ? <Meta>{integration.category}</Meta> : null}
        {/* Only where connecting is on offer: a step count on a coming-soon entry describes work
            nobody can start. */}
        {integration.availability !== "coming_soon" && steps ? (
          <Meta>
            {steps} step{steps === 1 ? "" : "s"}
          </Meta>
        ) : null}
      </div>
    </div>
  );
}

/*
 * Connection state, in the colour language the rest of the app already uses: green is working, red
 * is broken, blue is mid-flight, grey is not started.
 *
 * `disconnected` stays grey deliberately. Amber carries a warning triangle, and an integration
 * nobody has set up yet is not a fault to be warned about — it is the resting state of every entry
 * in a fresh catalog. Colouring it would make a healthy instance look like a wall of problems, and
 * spend the reader's attention on the one card that genuinely is one.
 *
 * The four states are kept apart rather than collapsed to connected/not: `error` and `connecting`
 * both used to print "Not connected", which is a different claim from the one the runtime is
 * making.
 */
export const CONNECTION: Record<McpConnectionStatus, { label: string; tone: StatusTone }> = {
  connected: { label: "Connected", tone: "success" },
  connecting: { label: "Connecting", tone: "info" },
  error: { label: "Error", tone: "danger" },
  disconnected: { label: "Not connected", tone: "neutral" },
};

/**
 * The card footer, on a hairline so every tile's action lands on the same line whatever the
 * description above it does.
 */
function Foot({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * The card's one action, stretched over the whole tile so the pointer target is the card the user
 * is already over. It stays an anchor to a real URL rather than a click handler, so open-in-new-tab,
 * Back and a shared link all keep working — `?view=` is the panel's address, not local state.
 */
function PreviewLink({ integration, label }: { integration: IntegrationSummary; label: string }) {
  return (
    <Link
      to={`?view=${encodeURIComponent(integration.name)}`}
      preventScrollReset
      aria-label={`${label} for ${displayName(integration)}`}
      className={cn(
        "flex items-center gap-1 rounded-sm font-medium text-foreground",
        "transition-colors duration-150 hover:text-primary",
        // The card carries the focus ring, because the stretched hit area is the card.
        "focus-visible:outline-none",
        "after:absolute after:inset-0 after:content-['']"
      )}
    >
      {label}
      {/* No leaves-here arrow: this opens a panel over the catalog, it does not navigate away. */}
      <ChevronRight aria-hidden className="size-3.5" />
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

  // Listed so the roadmap is visible, closed because there is no setup flow to hand over yet. The
  // preview still opens — a card that does nothing at all reads as broken rather than as pending —
  // but it leads to the panel, never to the detail page that would offer a connection this
  // deployment cannot honor.
  if (integration.availability === "coming_soon") {
    return (
      <Frame muted>
        <Body integration={integration} />
        <Foot className="bg-muted/40">
          <StatusBadge label="Coming soon" tone="info" />
          <PreviewLink integration={integration} label="View details" />
        </Foot>
      </Frame>
    );
  }

  // A curated entry that has not been cloned has no detail page to open — linking there would 404.
  // It is a card about a repository, not about an integration this deployment has.
  if (!integration.installed) {
    return (
      <Frame muted>
        <Body integration={integration} />
        <Foot className="bg-muted/40">
          <StatusBadge label="Not installed" tone="neutral" />
        </Foot>
      </Frame>
    );
  }

  return (
    <Frame>
      <Body integration={integration} />
      {integration.errorMessage && (
        <p className="px-4 pb-3 text-xs text-destructive">{integration.errorMessage}</p>
      )}
      <Foot className="bg-muted/40">
        <span className="flex items-center gap-1.5">
          <StatusBadge {...CONNECTION[integration.status]} />
          {integration.updateAvailable && <Badge variant="primary">Update available</Badge>}
        </span>
        <span className="flex items-center gap-2">
          {integration.updateAvailable && isAdmin && (
            <Button
              size="sm"
              variant="outline"
              disabled={updating}
              aria-label={`Update ${name}`}
              // The card is a stretched link, so this button needs its own stacking context to
              // stay clickable above it.
              className="relative z-10"
              onClick={() => onUpdate(integration.name, integration.source)}
            >
              {updating ? "Updating…" : "Update"}
            </Button>
          )}
          <PreviewLink integration={integration} label="View details" />
        </span>
      </Foot>
    </Frame>
  );
}
