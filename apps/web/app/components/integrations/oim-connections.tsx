import { useState } from "react";
import { StatusBadge, type StatusTone } from "~/components/status-badge";
import { Button } from "~/components/ui/button";
import { ConfirmModal } from "~/components/ui/modal";
import { ApiError } from "~/lib/api";
import {
  type OimConnectionRefreshResult,
  type OimConnectionSummary,
  refreshOimConnection,
  revokeOimConnection,
  startOimConnectionAuthorization,
} from "~/lib/integrations";
import { followAuthAction } from "./auth-flow";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Request failed.";
}

function healthPresentation(health: OimConnectionSummary["health"]["status"]): {
  label: string;
  tone: StatusTone;
} {
  switch (health) {
    case "healthy":
      return { label: "Working", tone: "success" };
    case "expiring":
      return { label: "Expires soon", tone: "warning" };
    case "action_required":
      return { label: "Action required", tone: "danger" };
    default:
      return { label: "Not checked", tone: "neutral" };
  }
}

function ownerLabel(owner: OimConnectionSummary["owner"]): string {
  if (owner.scope === "personal") return "Personal";
  if (owner.scope === "team") return `Team ${owner.teamId}`;
  return "Business";
}

function refreshMessage(result: OimConnectionRefreshResult): string {
  if (result.steps.some((step) => step.status === "action_required")) {
    return "One or more authorization steps need you to sign in again.";
  }
  if (result.steps.some((step) => step.status === "conflict")) {
    return "The Connection changed while it was checked. Reload and try again.";
  }
  if (result.steps.some((step) => step.status === "in_progress")) {
    return "Another refresh is already running.";
  }
  if (result.steps.some((step) => step.status === "renewed")) {
    return "Authorization refreshed.";
  }
  return "No authorization needed refreshing.";
}

function ConnectionRow({
  integrationKey,
  connection,
  actionName,
  onChanged,
}: {
  integrationKey: string;
  connection: OimConnectionSummary;
  actionName: string;
  onChanged: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [authorizingStep, setAuthorizingStep] = useState<string>();
  const [refreshResult, setRefreshResult] = useState<OimConnectionRefreshResult>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const health = healthPresentation(connection.health.status);
  const failedSteps =
    refreshResult?.steps.filter((step) => step.status === "action_required") ?? [];

  async function refreshAuthorization() {
    setRefreshing(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await refreshOimConnection(integrationKey, connection.id);
      setRefreshResult(result);
      setNotice(refreshMessage(result));
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRefreshing(false);
    }
  }

  async function reauthorize(stepId: string) {
    setAuthorizingStep(stepId);
    setError(undefined);
    setNotice(undefined);
    try {
      const action = await startOimConnectionAuthorization(integrationKey, connection.id, stepId);
      if (action.action === "pending") {
        setNotice(`Authorization step "${stepId}" is pending provider confirmation.`);
        setRefreshResult(undefined);
        onChanged();
        setAuthorizingStep(undefined);
        return;
      }
      if (followAuthAction(action) === "completed") {
        setNotice(`Authorization step "${stepId}" completed.`);
        setRefreshResult(undefined);
        onChanged();
        setAuthorizingStep(undefined);
      }
    } catch (caught) {
      setError(errorMessage(caught));
      setAuthorizingStep(undefined);
    }
  }

  async function revoke() {
    setRevoking(true);
    setError(undefined);
    try {
      const result = await revokeOimConnection(integrationKey, connection.id);
      if (result.status === "disconnect_pending") {
        setNotice("Disconnect is pending provider cleanup. This Connection cannot be used.");
      }
      setConfirmingRevoke(false);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium text-foreground">{connection.label}</h3>
            <StatusBadge
              label={
                connection.status === "revoked"
                  ? "Revoked"
                  : connection.disconnectPending
                    ? "Disconnecting"
                    : health.label
              }
              tone={
                connection.status === "revoked" || connection.disconnectPending
                  ? "neutral"
                  : health.tone
              }
            />
            {connection.isDefault ? <StatusBadge label="Default" tone="info" /> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {ownerLabel(connection.owner)} · version {connection.integration.majorVersion}
          </p>
          {connection.availableCredentialSlots.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {connection.availableCredentialSlots.length} credential{" "}
              {connection.availableCredentialSlots.length === 1 ? "slot" : "slots"} available
            </p>
          ) : null}
        </div>

        {connection.status === "active" && !connection.disconnectPending ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Check authorization for ${actionName}`}
              disabled={refreshing || revoking || authorizingStep !== undefined}
              onClick={refreshAuthorization}
            >
              {refreshing ? "Checking…" : "Check authorization"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Disconnect ${actionName}`}
              disabled={refreshing || revoking || authorizingStep !== undefined}
              onClick={() => {
                setError(undefined);
                setConfirmingRevoke(true);
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>

      {failedSteps.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <h4 className="text-sm font-medium text-foreground">Sign in again</h4>
          <p className="text-xs text-muted-foreground">
            Only the failed authorization steps are restarted. Existing credentials stay bound until
            the provider confirms replacements.
          </p>
          <div className="flex flex-wrap gap-2">
            {failedSteps.map((step) => (
              <Button
                key={step.stepId}
                type="button"
                size="sm"
                aria-label={`Reauthorize ${step.stepId} for ${actionName}`}
                disabled={authorizingStep !== undefined}
                onClick={() => reauthorize(step.stepId)}
              >
                {authorizingStep === step.stepId ? "Opening…" : `Reauthorize ${step.stepId}`}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div aria-live="polite" className="min-h-0 text-xs text-muted-foreground">
        {notice}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <ConfirmModal
        open={confirmingRevoke}
        onClose={() => {
          if (!revoking) setConfirmingRevoke(false);
        }}
        onConfirm={revoke}
        title={`Disconnect ${connection.label}?`}
        description="This revokes this exact Connection and its credentials. Other Connections stay active."
        confirmLabel="Disconnect Connection"
        busyLabel="Disconnecting…"
        busy={revoking}
        error={error ?? null}
      />
    </li>
  );
}

export function OimConnections({
  integrationKey,
  connections,
  onChanged,
}: {
  integrationKey: string;
  connections: OimConnectionSummary[];
  onChanged: () => void;
}) {
  const labelCounts = new Map<string, number>();
  for (const connection of connections) {
    labelCounts.set(connection.label, (labelCounts.get(connection.label) ?? 0) + 1);
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="oim-connections-heading">
      <div>
        <h2 id="oim-connections-heading" className="text-sm font-semibold text-foreground">
          Connections
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Each Connection keeps its own access, credentials, and provider authorization.
        </p>
      </div>

      {connections.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          No Connections are available.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              integrationKey={integrationKey}
              connection={connection}
              actionName={
                labelCounts.get(connection.label) === 1
                  ? connection.label
                  : `${connection.label}, Connection ${connection.id}`
              }
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
