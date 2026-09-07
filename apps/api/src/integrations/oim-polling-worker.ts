import { randomUUID } from "node:crypto";
import {
  advancePollingCursor,
  bodyDigest,
  type ConnectionPrincipal,
  type ConnectionUseAuthorizer,
  compileOimHttpOperations,
  type EgressHttpPort,
  OimHttpToolAdapter,
  pollingCursorRequestValue,
  selectEventType,
} from "@tulipfarm/integrations";
import type { OimEventType, OimManifest, OimPollingIngress } from "@tulipfarm/schema";
import type { SecretAuthorizer, SecretBroker } from "@tulipfarm/secrets";
import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type {
  ConnectionStore,
  PersistedConnection,
  PollingIngressStore,
  WebhookInboxStore,
} from "@tulipfarm/storage";
import type { TrackConnectionBroker } from "./connection-lease-registry";

export const OIM_POLLING_INTERVAL_MS = 5_000;
const POLL_LEASE_SECONDS = 120;
const POLL_SECRET_LEASE_TTL_MS = 30_000;

export interface OimPollingWorkerDeps {
  readonly connections: Pick<ConnectionStore, "findById" | "listPollingFallbacks">;
  readonly connectionAccess: ConnectionUseAuthorizer;
  readonly authorizeIntegration: (integration: SoulIntegration) => Promise<void>;
  readonly state: PollingIngressStore;
  readonly secrets: Pick<
    SecretBroker,
    "leaseConnection" | "leaseConnectionSet" | "revokeConnection"
  >;
  readonly trackConnectionBroker?: TrackConnectionBroker;
  readonly http: EgressHttpPort;
  readonly soulLoader: SoulLoader;
  readonly inbox: Pick<WebhookInboxStore, "record">;
  readonly encryptPayload: (raw: Buffer) => Promise<string>;
  readonly log: {
    info(detail: Record<string, unknown>, message: string): void;
    error(message: string): void;
  };
  readonly now?: () => Date;
  readonly newDeliveryId?: () => string;
  readonly newLeaseToken?: () => string;
}

function integrationFor(
  loader: SoulLoader,
  connection: PersistedConnection
): SoulIntegration | undefined {
  for (const integration of loader.integrations.values()) {
    const manifest = integration.oimManifest;
    if (
      manifest?.metadata.id === connection.integration.id &&
      Number(manifest.metadata.version.split(".", 1)[0]) === connection.integration.majorVersion
    ) {
      return integration;
    }
  }
  return undefined;
}

function pollingPrincipal(connection: PersistedConnection): ConnectionPrincipal {
  if (connection.owner.scope === "personal") {
    return { kind: "user", id: connection.owner.principalId };
  }
  return {
    kind: "integration_adapter",
    id: `integration:${connection.integration.id}`,
  };
}

interface AuthorizedPollingSource {
  readonly connection: PersistedConnection;
  readonly manifest: OimManifest;
  readonly ingress: OimPollingIngress;
  readonly eventTypes: readonly OimEventType[];
}

type PollingAuthorizationDeps = {
  readonly authorizeIntegration: OimPollingWorkerDeps["authorizeIntegration"];
  readonly connectionAccess: OimPollingWorkerDeps["connectionAccess"];
  readonly connections: Pick<ConnectionStore, "findById">;
  readonly soulLoader: OimPollingWorkerDeps["soulLoader"];
  readonly log: Pick<OimPollingWorkerDeps["log"], "error">;
};

async function authorizePollingSource(
  deps: PollingAuthorizationDeps,
  candidate: PersistedConnection,
  now: Date
): Promise<AuthorizedPollingSource | null> {
  const deny = (reason: string) => {
    deps.log.error(
      `OIM poll authorization failed for ${candidate.integration.id}/${candidate.id}: ${reason}`
    );
    return null;
  };
  try {
    const connection = await deps.connections.findById(candidate.businessId, candidate.id);
    if (connection === null) return deny("source Connection no longer exists");
    if (
      connection.businessId !== candidate.businessId ||
      connection.integration.id !== candidate.integration.id ||
      connection.integration.majorVersion !== candidate.integration.majorVersion
    )
      return deny("source Connection binding changed");
    if (connection.status !== "active") return deny("source Connection is inactive");
    if (connection.health.status === "action_required")
      return deny("source Connection requires action");
    if (connection.webhookRegistration !== undefined)
      return deny("source Connection now has webhook ingress");
    if (connection.expiresAt !== null && Date.parse(connection.expiresAt) <= now.getTime())
      return deny("source Connection expired");
    if (!(await deps.connectionAccess.canUse(pollingPrincipal(connection), connection)))
      return deny("source Connection use is not authorized");
    const integration = integrationFor(deps.soulLoader, connection);
    const manifest = integration?.oimManifest;
    const ingress = manifest?.ingress;
    if (integration === undefined || manifest === undefined || ingress?.kind !== "polling")
      return deny("installed polling Integration is unavailable");
    const eventTypes = ingress.eventTypes ?? manifest.events?.eventTypes;
    if (eventTypes === undefined) return deny("polling event contract is unavailable");
    await deps.authorizeIntegration(integration);
    return { connection, manifest, ingress, eventTypes };
  } catch (error) {
    deps.log.error(
      `OIM poll authorization failed for ${candidate.integration.id}/${candidate.id}: ${messageOf(error)}`
    );
    return null;
  }
}

export interface OimPollingSecretAuthorizerDeps {
  readonly businessId: string;
  readonly connections: Pick<ConnectionStore, "findById">;
  readonly connectionAccess: ConnectionUseAuthorizer;
  readonly authorizeIntegration: (integration: SoulIntegration) => Promise<void>;
  readonly soulLoader: SoulLoader;
  readonly now?: () => Date;
}

/** Rechecks the exact polling source before every Connection Secret lease is issued. */
export function oimPollingSecretAuthorizer(deps: OimPollingSecretAuthorizerDeps): SecretAuthorizer {
  const denied = { allowed: false as const, reason: "not_authorized" as const };
  return {
    async authorize(scope) {
      try {
        if (
          scope.purpose !== "oim-polling" ||
          scope.connectionId === undefined ||
          scope.credentialSlot === undefined ||
          scope.integrationId === undefined ||
          scope.principalKind === undefined ||
          scope.principalId === undefined ||
          scope.destination === undefined
        ) {
          return denied;
        }
        const candidate = await deps.connections.findById(deps.businessId, scope.connectionId);
        if (candidate === null) return denied;
        const source = await authorizePollingSource(
          {
            ...deps,
            log: { error: () => {} },
          },
          candidate,
          (deps.now ?? (() => new Date()))()
        );
        if (source === null) return denied;
        const principal = pollingPrincipal(source.connection);
        if (
          source.connection.businessId !== deps.businessId ||
          source.connection.id !== scope.connectionId ||
          source.connection.integration.id !== scope.integrationId ||
          source.connection.secretBindings[scope.credentialSlot] !== scope.secretRef ||
          principal.kind !== scope.principalKind ||
          principal.id !== scope.principalId ||
          scope.runId !== `poll-${source.connection.id}` ||
          scope.stateId !== `poll-${source.connection.id}`
        ) {
          return denied;
        }
        const tool = compileOimHttpOperations(
          source.manifest,
          Object.fromEntries(
            Object.entries(source.connection.configuration).map(([key, value]) => [
              key,
              String(value),
            ])
          )
        ).find((candidateTool) => candidateTool.operation.id === source.ingress.operationId);
        if (
          tool === undefined ||
          tool.toolId !== scope.toolId ||
          new URL(tool.binding.baseUrl).host !== scope.destination ||
          ![tool.operation.credentialSlot, tool.operation.secondaryCredential?.slot].includes(
            scope.credentialSlot
          )
        ) {
          return denied;
        }
        return { allowed: true, maxTtlMs: POLL_SECRET_LEASE_TTL_MS, maxUses: 1 };
      } catch {
        return denied;
      }
    },
  };
}

async function dispatchWithLeasedCredentials(
  deps: OimPollingWorkerDeps,
  manifest: OimManifest,
  connection: PersistedConnection,
  operationId: string,
  cursor: string | number | null,
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
  const principal = pollingPrincipal(connection);
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
        principalKind: principal.kind,
        principalId: principal.id,
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
  for (const candidate of await deps.connections.listPollingFallbacks()) {
    const authorized = await authorizePollingSource(deps, candidate, now);
    if (authorized === null) continue;
    const { connection, ingress } = authorized;
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
      const current = await authorizePollingSource(
        deps,
        connection,
        (deps.now ?? (() => new Date()))()
      );
      if (current === null) {
        await deps.state.release(
          connection.businessId,
          connection.id,
          leaseToken,
          ingress.intervalSeconds,
          now
        );
        continue;
      }
      const requestCursor = pollingCursorRequestValue(lease.cursor, current.ingress.cursor);
      const response = await dispatchWithLeasedCredentials(
        deps,
        current.manifest,
        current.connection,
        current.ingress.operationId,
        requestCursor,
        leaseToken
      );
      const cursor = advancePollingCursor(response, lease.cursor, current.ingress.cursor);
      for (const delivery of cursor.deliveries) {
        const eventType = selectEventType(
          { eventTypes: current.eventTypes },
          {
            body: delivery.payload,
            headers: {},
          }
        );
        if (eventType === undefined) throw new Error("poll response item has no event type");
        const rawBody = Buffer.from(JSON.stringify(delivery.payload), "utf8");
        await deps.inbox.record(connection.businessId, {
          id: (deps.newDeliveryId ?? randomUUID)(),
          integrationId: current.connection.integration.id,
          integrationMajorVersion: current.connection.integration.majorVersion,
          connectionId: current.connection.id,
          deduplicationKey: `poll:${current.connection.id}:${delivery.deduplicationKey}`,
          bodySha256: bodyDigest(rawBody),
          safeHeaders: {},
          encryptedBody: await deps.encryptPayload(rawBody),
          eventType: eventType.type,
          verification: "polling",
        });
      }
      if (
        await deps.state.complete(
          connection.businessId,
          connection.id,
          leaseToken,
          cursor.cursor,
          current.ingress.intervalSeconds,
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
  const releaseBroker = deps.trackConnectionBroker?.(deps.secrets);
  let polling = false;
  let stopped = false;
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
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      releaseBroker?.();
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
