import { type DrainDeps, drainInbox, type IntegrationEvent } from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { WebhookInboxStore } from "@tulipfarm/storage";

/**
 * The background half of Integration Events: everything the webhook route deliberately did not do
 * while a provider was waiting on the connection.
 */

export interface WebhookInboxWorkerDeps {
  readonly inbox: WebhookInboxStore;
  readonly soulLoader: SoulLoader;
  readonly decryptPayload: (encrypted: string) => Promise<Buffer>;
  readonly hookRunnerFor?: DrainDeps["hookRunnerFor"];
  /** The single Integration-event-to-Run seam. */
  readonly dispatch: (event: IntegrationEvent) => Promise<void>;
  readonly newEventId: () => string;
  readonly log: {
    info(detail: Record<string, unknown>, message: string): void;
    error(message: string): void;
  };
}

/** Seven days, per the Events profile. Long enough to replay a bad week, short enough to forget. */
export const DEFAULT_RAW_RETENTION_DAYS = 7;

const DRAIN_INTERVAL_MS = 5_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Reads the installed manifest for a delivery.
 *
 * Version is matched, not merely the id: a delivery accepted under v1 must not be normalized by v2
 * rules, because the payload it holds is the one v1 promised to understand.
 */
function manifestReader(
  soulLoader: SoulLoader
): (
  businessId: string,
  integrationId: string,
  majorVersion: number
) => Promise<OimManifest | null> {
  return async (_businessId, integrationId, majorVersion) => {
    for (const integration of soulLoader.integrations.values()) {
      const manifest = integration.oimManifest;
      if (manifest?.metadata.id !== integrationId) continue;
      if (Number(manifest.metadata.version.split(".", 1)[0]) !== majorVersion) continue;
      return manifest;
    }
    return null;
  };
}

export function webhookInboxDrainDeps(deps: WebhookInboxWorkerDeps): DrainDeps {
  return {
    inbox: deps.inbox,
    manifestFor: manifestReader(deps.soulLoader),
    decryptPayload: deps.decryptPayload,
    emit: deps.dispatch,
    ...(deps.hookRunnerFor === undefined ? {} : { hookRunnerFor: deps.hookRunnerFor }),
  };
}

export interface WebhookInboxWorker {
  stop(): void;
}

/**
 * Starts the normalization drain and the retention sweep.
 *
 * Both re-entrancy guards matter: a drain that overlaps itself would double every lease's
 * concurrency for no gain, and a retention sweep that overlaps would run the same delete twice.
 */
export function startWebhookInboxWorker(deps: WebhookInboxWorkerDeps): WebhookInboxWorker {
  const drainDeps = webhookInboxDrainDeps(deps);
  let draining = false;
  let sweeping = false;

  const drain = setInterval(() => {
    if (draining) return;
    draining = true;
    void drainInbox(drainDeps)
      .then((summary) => {
        if (summary.claimed > 0) deps.log.info({ ...summary }, "webhook inbox drained");
      })
      .catch((error: unknown) => {
        deps.log.error(`webhook inbox drain failed — ${messageOf(error)}`);
      })
      .finally(() => {
        draining = false;
      });
  }, DRAIN_INTERVAL_MS);
  drain.unref?.();

  const sweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    const before = new Date(Date.now() - DEFAULT_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    void deps.inbox
      .discardRawPayloadsBefore(before)
      .then((discarded) => {
        if (discarded > 0) deps.log.info({ discarded }, "webhook raw payloads discarded");
      })
      .catch((error: unknown) => {
        deps.log.error(`webhook payload retention sweep failed — ${messageOf(error)}`);
      })
      .finally(() => {
        sweeping = false;
      });
  }, RETENTION_INTERVAL_MS);
  sweep.unref?.();

  return {
    stop() {
      clearInterval(drain);
      clearInterval(sweep);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
