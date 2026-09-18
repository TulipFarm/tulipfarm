import { useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import {
  getIntegrationOperations,
  type IntegrationOperationsView,
  type KnowledgeSubscription,
  saveKnowledgeSubscription,
} from "~/lib/integration-operations";

function when(value: string | null): string {
  return value === null ? "Not recorded" : new Date(value).toLocaleString();
}

function SubscriptionForm({
  integrationKey,
  connectionId,
  sourceKind,
  subscription,
  canEnable,
  onSaved,
}: {
  integrationKey: string;
  connectionId: string;
  sourceKind: IntegrationOperationsView["sourceKinds"][number];
  subscription?: KnowledgeSubscription;
  canEnable: boolean;
  onSaved: () => void;
}) {
  const id = useId();
  const [scopes, setScopes] = useState(subscription?.scopes.join("\n") ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(enabled: boolean) {
    setPending(true);
    setError(null);
    try {
      await saveKnowledgeSubscription(integrationKey, connectionId, {
        sourceKindId: sourceKind.id,
        scopes: enabled
          ? [
              ...new Set(
                scopes
                  .split("\n")
                  .map((scope) => scope.trim())
                  .filter(Boolean)
              ),
            ]
          : (subscription?.scopes ?? []),
        enabled,
      });
      onSaved();
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 409
          ? "Check this Connection’s authorization before enabling sync, then try again."
          : "Could not save the subscription. Check the selected scopes and your access, then retry."
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="space-y-2 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save(true);
      }}
    >
      <label htmlFor={id} className="block text-sm font-medium">
        {sourceKind.label} scopes
      </label>
      {sourceKind.description && (
        <p className="text-xs text-muted-foreground">{sourceKind.description}</p>
      )}
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Enter provider scope identifiers, one per line (up to 100). Only these scopes will be
        synced.
      </p>
      <textarea
        id={id}
        aria-describedby={`${id}-help`}
        value={scopes}
        onChange={(event) => setScopes(event.target.value)}
        rows={3}
        maxLength={102500}
        required
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        disabled={pending}
      />
      <p className="text-xs text-muted-foreground">
        {subscription ? (subscription.enabled ? "Enabled" : "Disabled") : "Not configured"}
        {" · "}Last completed sync: {when(subscription?.lastSuccessAt ?? null)}
        {" · "}Last attempt: {when(subscription?.lastAttemptAt ?? null)}
      </p>
      {(subscription?.lastErrorCodes.length ?? 0) > 0 && (
        <p role="status" className="text-xs text-destructive">
          Sync could not complete. Check Connection authorization and provider access to these
          scopes. Failure codes: {subscription?.lastErrorCodes.join(", ")}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || !canEnable || scopes.trim() === ""}>
          {subscription?.enabled ? "Update selected scopes" : "Enable Knowledge sync"}
        </Button>
        {subscription?.enabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void save(false)}
          >
            Disable sync
          </Button>
        )}
      </div>
      {!canEnable && (
        <p className="text-xs text-muted-foreground">
          Complete Connection authorization before enabling sync.
        </p>
      )}
    </form>
  );
}

export function IntegrationOperations({ integrationKey }: { integrationKey: string }) {
  const [view, setView] = useState<IntegrationOperationsView | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit refresh invalidates recorded evidence after a user read or write.
  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError(false);
    setUnsupported(false);
    getIntegrationOperations(integrationKey, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setView(result);
      },
      (error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) setUnsupported(true);
        else setError(true);
      }
    );
    return () => controller.abort();
  }, [integrationKey, refresh]);
  if (unsupported) return null;
  return (
    <section aria-label="Integration operations" className="space-y-4 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Operations &amp; Knowledge sync</h2>
        <Button type="button" size="sm" variant="outline" onClick={() => setRefresh(refresh + 1)}>
          Refresh status
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Operational status is unavailable. Check your access or refresh to retry.
        </p>
      ) : view === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading operational evidence…
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Recorded evidence as of {when(view.observedAt)}; not a live provider health check.
            Delivery counts describe ingress handoff, not completed Runs or outbound replies.
          </p>
          {view.ingress === "websocket" && (
            <p role="alert" className="text-sm text-destructive">
              This package declares WebSocket ingress, which this deployment does not support. It
              will not receive events.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Live socket health is not recorded by this endpoint.
          </p>
          {view.connections.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No Connections you can manage. Complete Connection setup first.
            </p>
          )}
          {view.connections.map((connection) => (
            <div key={connection.connectionId} className="space-y-3 rounded-md border p-3">
              <h3 className="text-sm font-medium">{connection.label}</h3>
              <dl className="grid gap-1 text-xs text-muted-foreground">
                <div>
                  <dt className="inline">Webhook registration: </dt>
                  <dd className="inline">
                    {connection.operations.webhook?.state.replaceAll("_", " ") ?? "Not recorded"}
                  </dd>
                </div>
                {connection.operations.webhook && (
                  <div>
                    Registration attempts: {connection.operations.webhook.attempts}
                    {" · "}Next attempt eligible:{" "}
                    {when(connection.operations.webhook.nextAttemptAt)}
                  </div>
                )}
                <div>
                  Ingress handoff: {connection.operations.delivery.pending} pending
                  {" · "}
                  {connection.operations.delivery.retrying} retrying
                  {" · "}
                  {connection.operations.delivery.deadLetter} dead-lettered
                  {" · "}
                  {connection.operations.delivery.dispatched} dispatched
                </div>
                <div>
                  Next delivery attempt eligible:{" "}
                  {when(connection.operations.delivery.nextAttemptAt)}
                </div>
                <div>
                  Next provider poll eligible:{" "}
                  {when(connection.operations.polling?.nextPollAt ?? null)}
                </div>
                <div>
                  Poll lease expires: {when(connection.operations.polling?.leaseExpiresAt ?? null)}
                </div>
              </dl>
              {(connection.operations.webhook?.hasError ||
                connection.operations.delivery.hasError) && (
                <p role="status" className="text-xs text-destructive">
                  An ingress error is recorded. Check authorization and the integration-worker logs.
                  Dead-lettered deliveries require operator investigation; refreshing this view does
                  not retry them.
                </p>
              )}
              {view.sourceKinds.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Sync preserves provider ACLs
                  {view.liveAuthorization ? " and live authorization" : ""}. Disabling sync stops
                  future scans; it does not erase indexed content or change its access rules.
                </p>
              )}
              {view.sourceKinds.map((sourceKind) => {
                const subscription = connection.subscriptions.find(
                  (entry) => entry.sourceKindId === sourceKind.id
                );
                return (
                  <SubscriptionForm
                    key={`${sourceKind.id}:${subscription?.scopes.join("\n")}:${subscription?.enabled}`}
                    integrationKey={integrationKey}
                    connectionId={connection.connectionId}
                    sourceKind={sourceKind}
                    subscription={subscription}
                    canEnable={
                      !connection.disconnectPending &&
                      ["healthy", "expiring"].includes(connection.authorization)
                    }
                    onSaved={() => setRefresh((value) => value + 1)}
                  />
                );
              })}
              {connection.operations.sync.map((sync) => (
                <p
                  key={`${sync.sourceKindId}:${sync.scope}`}
                  className="text-xs text-muted-foreground"
                >
                  {sync.scope}:{" "}
                  {sync.inProgress ? "Scan in progress or awaiting retry" : "No scan in progress"}
                  {" · "}
                  {sync.pendingDeletions} pending deletions
                  {sync.requiresFullRebuild ? " · Full rebuild required" : ""}
                  {" · "}Checkpoint updated: {when(sync.updatedAt)}
                </p>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
