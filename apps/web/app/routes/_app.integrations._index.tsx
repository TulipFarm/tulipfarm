import {
  Link,
  type MetaFunction,
  useLoaderData,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { IntegrationsTabs } from "~/components/integrations-tabs";
import { ResourcePanel } from "~/components/resource-panel";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  connectIntegration,
  disconnectIntegration,
  type IntegrationSummary,
  listIntegrations,
  type McpConnectionStatus,
} from "~/lib/integrations";

export const meta: MetaFunction = () => [{ title: "Integrations · tulipfarm" }];

export async function clientLoader() {
  const integrations = await listIntegrations();
  return { integrations };
}

const STATUS_CLASS: Record<McpConnectionStatus, string> = {
  connected: "border-border text-muted-foreground",
  connecting: "border-primary text-primary",
  error: "border-destructive text-destructive",
  disconnected: "border-border text-muted-foreground",
};

function StatusBadge({ status }: { status: McpConnectionStatus }) {
  return (
    <span
      className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-xs uppercase tracking-[0.15em] ${STATUS_CLASS[status]}`}
    >
      {status}
    </span>
  );
}

function IntegrationRow({ integration }: { integration: IntegrationSummary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const revalidator = useRevalidator();

  async function handleDisconnect(e: React.MouseEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await disconnectIntegration(integration.name);
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col">
      <div className="group flex items-baseline gap-2 px-3 py-2">
        <span aria-hidden className="text-primary">
          ▸
        </span>
        <Link
          to={`/integrations/${encodeURIComponent(integration.name)}`}
          className="font-medium text-foreground hover:underline"
        >
          {integration.name}
        </Link>
        {integration.description ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {integration.description}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <StatusBadge status={integration.status} />
        {integration.status === "connected" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={handleDisconnect}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : (
          <Button asChild size="sm">
            <Link to={`/integrations/${encodeURIComponent(integration.name)}`}>Connect</Link>
          </Button>
        )}
      </div>
      {integration.errorMessage && (
        <p className="px-3 pb-2 text-xs text-destructive">{integration.errorMessage}</p>
      )}
      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </li>
  );
}

export default function IntegrationsIndex() {
  const { integrations } = useLoaderData<typeof clientLoader>();

  return (
    <ResourcePanel crumbs={[{ label: "integrations" }]}>
      <IntegrationsTabs />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {integrations.length} {integrations.length === 1 ? "integration" : "integrations"}
        </p>
        <Button asChild size="sm">
          <Link to="/integrations/marketplace">Browse marketplace</Link>
        </Button>
      </div>
      {integrations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No integrations installed yet — browse the marketplace to add one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
          {integrations.map((i) => (
            <IntegrationRow key={i.name} integration={i} />
          ))}
        </ul>
      )}
    </ResourcePanel>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="integrations" status={status} message={message} />;
}
