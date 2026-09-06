import { randomUUID } from "node:crypto";
import {
  compileOimHttpOperations,
  type EgressHttpPort,
  type IntegrationEvent,
  normalizeDelivery,
  OimHttpToolAdapter,
  readPointer,
  selectEventType,
} from "@tulipfarm/integrations";
import type { OimManifest } from "@tulipfarm/schema";
import type { SecretBroker } from "@tulipfarm/secrets";
import type { SoulLoader } from "@tulipfarm/soul";
import type { ConnectionStore, PersistedConnection, PollingIngressStore } from "@tulipfarm/storage";

export const OIM_POLLING_INTERVAL_MS = 5_000;
const POLL_LEASE_SECONDS = 120;

export interface OimPollingWorkerDeps {
  readonly connections: Pick<ConnectionStore, "listPollingFallbacks">;
  readonly state: PollingIngressStore;
  readonly secrets: Pick<SecretBroker, "leaseConnection" | "leaseConnectionSet">;
  readonly http: EgressHttpPort;
  readonly soulLoader: SoulLoader;
  readonly dispatch: (event: IntegrationEvent) => Promise<void>;
  readonly log: {
    info(detail: Record<string, unknown>, message: string): void;
    error(message: string): void;
  };
  readonly now?: () => Date;
  readonly newLeaseToken?: () => string;
}

function manifestFor(loader: SoulLoader, connection: PersistedConnection): OimManifest | undefined {
  for (const integration of loader.integrations.values()) {
    const manifest = integration.oimManifest;
    if (
      manifest?.metadata.id === connection.integration.id &&
      Number(manifest.metadata.version.split(".", 1)[0]) === connection.integration.majorVersion
    ) {
      return manifest;
    }
  }
  return undefined;
}

function responseCursor(response: unknown, pointer: string): string | null {
  const value = readPointer(response, pointer);
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function dispatchWithLeasedCredentials(
  deps: OimPollingWorkerDeps,
  manifest: OimManifest,
  connection: PersistedConnection,
  operationId: string,
  cursor: string | null,
  leaseToken: string
): Promise<unknown> {
  const tool = compileOimHttpOperations(
    manifest,
    Object.fromEntries(
      Object.entries(connection.configuration).map(([key, value]) => [key, String(value)])
    )
  ).find((candidate) => candidate.operation.id === operationId);
  if (tool === undefined) throw new Error(`poll operation ${operationId} is not native HTTP`);
  const slots = [tool.operation.credentialSlot, tool.operation.secondaryCredential?.slot].filter(
    (slot): slot is string => slot !== undefined
  );
  const adapter = new OimHttpToolAdapter({
    binding: tool.binding,
    http: deps.http,
    toolId: tool.toolId,
    ...(tool.projection === undefined ? {} : { projection: tool.projection }),
  });
  const request = (credentials: Readonly<Record<string, string>>) =>
    adapter.dispatch(
      {
        intent: {
          intentId: `poll-${connection.id}-${leaseToken}`,
          businessId: connection.businessId,
          runId: `poll-${connection.id}`,
          stateId: `poll-${connection.id}`,
          toolId: tool.toolId,
          toolVersion: manifest.metadata.version,
          action: `integration.${manifest.metadata.id}.${tool.operation.name}`,
          targetRefs: [],
          arguments:
            cursor === null
              ? {}
              : { [manifest.ingress?.cursor.requestParameter ?? "cursor"]: cursor },
          idempotencyKey: `poll-${connection.id}-${leaseToken}`,
        },
        idempotencyKey: `poll-${connection.id}-${leaseToken}`,
        attempt: 1,
      },
      tool.operation.credentialSlot === undefined
        ? undefined
        : credentials[tool.operation.credentialSlot],
      credentials
    );
  if (slots.length === 0) return request({});
  const scopeFor = (slot: string) => {
    const secretRef = connection.secretBindings[slot];
    if (secretRef === undefined)
      throw new Error(`poll operation requires unbound credential ${slot}`);
    return {
      scope: {
        secretRef: secretRef as `secret://${string}`,
        connectionId: connection.id,
        credentialSlot: slot,
        integrationId: connection.integration.id,
        toolId: tool.toolId,
        runId: `poll-${connection.id}`,
        stateId: `poll-${connection.id}`,
        purpose: "oim-polling",
        destination: new URL(tool.binding.baseUrl).host,
      },
    };
  };
  if (slots.length === 1) {
    const lease = await deps.secrets.leaseConnection(scopeFor(slots[0] as string));
    return lease.use((credential) => request({ [slots[0] as string]: credential }));
  }
  const [first, second] = slots as [string, string];
  const leases = await deps.secrets.leaseConnectionSet({
    [first]: scopeFor(first),
    [second]: scopeFor(second),
  });
  return leases.use(request);
}

export async function pollOimIngress(deps: OimPollingWorkerDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  let completed = 0;
  for (const connection of await deps.connections.listPollingFallbacks()) {
    const manifest = manifestFor(deps.soulLoader, connection);
    const ingress = manifest?.ingress;
    if (manifest === undefined || ingress?.kind !== "polling" || manifest.events === undefined)
      continue;
    const leaseToken = (deps.newLeaseToken ?? randomUUID)();
    const lease = await deps.state.claim(
      connection.businessId,
      connection.id,
      leaseToken,
      POLL_LEASE_SECONDS,
      now
    );
    if (lease === null) continue;
    try {
      const response = await dispatchWithLeasedCredentials(
        deps,
        manifest,
        connection,
        ingress.operationId,
        lease.cursor,
        leaseToken
      );
      const nextCursor = responseCursor(response, ingress.cursor.responsePointer);
      const eventType = selectEventType(manifest.events, { body: response, headers: {} });
      if (nextCursor === null || eventType === undefined)
        throw new Error("poll response has no cursor or event type");
      const normalized = await normalizeDelivery(eventType, { payload: response, safeHeaders: {} });
      if (normalized.kind !== "normalized") throw new Error(normalized.reason);
      await deps.dispatch({
        businessId: connection.businessId,
        integrationId: connection.integration.id,
        integrationMajorVersion: connection.integration.majorVersion,
        connectionId: connection.id,
        deliveryId: `poll:${connection.id}:${nextCursor}`,
        type: normalized.event.type,
        payload: normalized.event.payload,
        safeHeaders: {},
        replayOfId: null,
      });
      if (
        await deps.state.complete(
          connection.businessId,
          connection.id,
          leaseToken,
          nextCursor,
          ingress.intervalSeconds,
          now
        )
      ) {
        completed += 1;
      }
    } catch (error) {
      await deps.state.release(
        connection.businessId,
        connection.id,
        leaseToken,
        ingress.intervalSeconds,
        now
      );
      deps.log.error(
        `OIM poll failed for ${connection.integration.id}/${connection.id}: ${messageOf(error)}`
      );
    }
  }
  return completed;
}

export interface OimPollingWorker {
  stop(): void;
}

/** Starts the polling fallback in the API runtime, where the live Soul and secret broker are owned. */
export function startOimPollingWorker(deps: OimPollingWorkerDeps): OimPollingWorker {
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void pollOimIngress(deps)
      .then((completed) => {
        if (completed > 0) deps.log.info({ completed }, "OIM polling ingress completed");
      })
      .catch((error: unknown) => deps.log.error(`OIM polling ingress failed: ${messageOf(error)}`))
      .finally(() => {
        polling = false;
      });
  }, OIM_POLLING_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
