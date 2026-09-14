import { randomUUID } from "node:crypto";
import {
  compileKnowledgeProfile,
  drainInbox,
  type KnowledgeProfilePlan,
  type OimKnowledgeApiPort,
  OimWebhookRegistrationService,
  pollOimIngress,
  syncOimKnowledge,
} from "@tulipfarm/integrations";
import { canonicalHash } from "@tulipfarm/schema";
import {
  ConnectionExternalIdentityStore,
  ConnectionStore,
  IngressTeardownStore,
  OimIngressEmissionStore,
  OimKnowledgeCheckpointStore,
  OimKnowledgePublicationStore,
  PollingIngressStore,
  transactionPort,
  WebhookInboxStore,
  WebhookRegistrationStore,
} from "@tulipfarm/storage";
import type { Pool } from "pg";
import { type OimIngressWorkerCycle, startOimIngressLoops } from "./oim-ingress/worker";
import {
  type OimKnowledgeSyncRegistration,
  startOimKnowledgeSyncLoop,
} from "./oim-knowledge/sync-loop";
import type {
  OimKnowledgeRegistration,
  OimPollingRegistration,
  OimWorkerHost,
} from "./oim-worker-host";
import type { DrainableLoop } from "./shutdown";

export interface OimRuntimeLog {
  info(detail: Readonly<Record<string, unknown>>, message: string): void;
  error(detail: Readonly<Record<string, unknown>>, message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface OimRuntimeCycle extends OimIngressWorkerCycle {
  loadKnowledgeRegistrations(): Promise<readonly OimKnowledgeSyncRegistration[]>;
}

export interface StartOimRuntimeDeps extends OimRuntimeCycle {
  readonly assertReady: () => Promise<void>;
  readonly log: OimRuntimeLog;
  readonly ingressIntervalMs?: number;
  readonly knowledgeIntervalMs?: number;
}

export async function startOimRuntime(
  signal: AbortSignal,
  deps: StartOimRuntimeDeps
): Promise<readonly DrainableLoop[]> {
  await deps.assertReady();
  return [
    ...startOimIngressLoops(signal, {
      cycle: deps,
      log: deps.log,
      intervalMs: deps.ingressIntervalMs,
    }),
    startOimKnowledgeSyncLoop(signal, {
      registrations: deps.loadKnowledgeRegistrations,
      log: deps.log,
      pollIntervalMs: deps.knowledgeIntervalMs,
    }),
  ];
}

interface OimStores {
  readonly connections: ConnectionStore;
  readonly identities: ConnectionExternalIdentityStore;
  readonly teardowns: IngressTeardownStore;
  readonly registrations: WebhookRegistrationStore;
  readonly polling: PollingIngressStore;
  readonly inbox: WebhookInboxStore;
  readonly emissions: OimIngressEmissionStore;
  readonly knowledgeCheckpoints: OimKnowledgeCheckpointStore;
  readonly knowledgePublications: OimKnowledgePublicationStore;
}

export interface OimPollingStores {
  readonly connections: Pick<ConnectionStore, "findById">;
  readonly identities: Pick<ConnectionExternalIdentityStore, "find">;
  readonly teardowns: Pick<IngressTeardownStore, "isDisabled">;
  readonly polling: Pick<
    PollingIngressStore,
    "claim" | "complete" | "release" | "recordVerifiedIfActive"
  >;
}

export type OimPollingHost = Pick<
  OimWorkerHost,
  | "encryptPayload"
  | "executePollingOperation"
  | "listPollingRegistrations"
  | "resolveConnectionManifest"
>;

export interface ComposeOimRuntimeOptions {
  readonly pool: Pool;
  readonly host: OimWorkerHost;
  readonly log: OimRuntimeLog;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export async function composeOimRuntime(
  signal: AbortSignal,
  options: ComposeOimRuntimeOptions
): Promise<readonly DrainableLoop[]> {
  const identifiers = {
    now: options.now ?? (() => new Date()),
    newId: options.newId ?? randomUUID,
  };
  const stores = createOimStores(options.pool, identifiers.newId);
  const cycle = createOimRuntimeCycle(stores, options.host, identifiers);
  return startOimRuntime(signal, {
    ...cycle,
    assertReady: () => options.host.assertReady(),
    log: options.log,
  });
}

function createOimStores(pool: Pool, newId: () => string): OimStores {
  const transactions = transactionPort(pool);
  return {
    connections: new ConnectionStore(transactions),
    identities: new ConnectionExternalIdentityStore(transactions),
    teardowns: new IngressTeardownStore(transactions),
    registrations: new WebhookRegistrationStore(transactions),
    polling: new PollingIngressStore(transactions),
    inbox: new WebhookInboxStore(transactions),
    emissions: new OimIngressEmissionStore(transactions, newId),
    knowledgeCheckpoints: new OimKnowledgeCheckpointStore(transactions),
    knowledgePublications: new OimKnowledgePublicationStore(transactions),
  };
}

function createOimRuntimeCycle(
  stores: OimStores,
  host: OimWorkerHost,
  identifiers: {
    readonly now: () => Date;
    readonly newId: () => string;
  }
): OimRuntimeCycle {
  const registrationService = new OimWebhookRegistrationService({
    registrations: stores.registrations,
    credentials: {
      stage: (input) => host.stageWebhookCredential(input),
      revoke: (input) => host.revokeWebhookCredential(input),
      revokeAttempt: (input) => host.revokeWebhookCredentialAttempt(input),
    },
    provider: {
      register: (input) => host.registerWebhook(input),
      reconcile: (input) => host.reconcileWebhook(input),
      renew: (input) => host.renewWebhook(input),
      unregister: (input) => host.unregisterWebhook(input),
    },
    manifestFor: (integrationKey) => host.resolveRegistrationManifest(integrationKey),
    newLeaseToken: identifiers.newId,
    now: identifiers.now,
  });

  return {
    recoverRegistrations: async () => {
      await registrationService.recover();
    },
    pollConnections: async () => {
      await pollOimIngress(createOimPollingDeps(stores, host, identifiers));
    },
    superviseWebsockets: async () => {
      // Dormant until a manifest declares websocket ingress and a Connection source is resolved.
      // The provider-neutral supervisor and its single-holder lease store are wired and tested;
      // no provider migration ships in this change, so there is nothing to supervise yet.
      return { supervised: 0 };
    },
    drainInbox: async () => {
      await drainInbox(createDeliveryDeps(stores, host, identifiers));
    },
    loadKnowledgeRegistrations: async () =>
      createKnowledgeRegistrations(
        await host.listKnowledgeRegistrations(),
        stores,
        host,
        identifiers
      ),
  };
}

export function createOimPollingDeps(
  stores: OimPollingStores,
  host: OimPollingHost,
  identifiers: {
    readonly now: () => Date;
    readonly newId: () => string;
  }
): Parameters<typeof pollOimIngress>[0] {
  const resolveSource = async (key: OimPollingRegistration) => {
    const connection = await stores.connections.findById(key.businessId, key.connectionId);
    if (
      !connection ||
      connection.integration.id !== key.integrationId ||
      connection.integration.majorVersion !== key.integrationMajorVersion ||
      !isConnectionUsable(connection, identifiers.now()) ||
      (await stores.teardowns.isDisabled(key.businessId, key.connectionId))
    ) {
      return null;
    }
    const identity = await stores.identities.find(key.businessId, key.connectionId);
    if (
      !identity ||
      identity.integrationId !== connection.integration.id ||
      identity.integrationMajorVersion !== connection.integration.majorVersion
    ) {
      return null;
    }
    const manifest = await host.resolveConnectionManifest(key);
    if (!manifest) {
      return null;
    }
    const ingress = manifest.ingress;
    if (ingress?.kind !== "polling" || !ingress.eventTypes) {
      return null;
    }
    return {
      ...key,
      manifest,
      ingress,
      eventTypes: ingress.eventTypes,
      verifiedIdentity: {
        externalTenantId: identity.externalTenantId,
        externalAccountId: identity.externalAccountId,
      },
    };
  };

  return {
    candidates: () => host.listPollingRegistrations(),
    resolveSource,
    execute: (input) =>
      host.executePollingOperation({
        businessId: input.source.businessId,
        connectionId: input.source.connectionId,
        integrationId: input.source.integrationId,
        integrationMajorVersion: input.source.integrationMajorVersion,
        operationId: input.source.ingress.operationId,
        expectedManifestDigest: canonicalHash(input.source.manifest),
        cursor: input.cursor,
        leaseToken: input.leaseToken,
        purpose: "ingress_poll",
      }),
    reauthorizeSource: async (source) => {
      const current = await resolveSource(source);
      return Boolean(
        current &&
          canonicalHash(current.manifest) === canonicalHash(source.manifest) &&
          sameVerifiedIdentity(current.verifiedIdentity, source.verifiedIdentity)
      );
    },
    state: stores.polling,
    recordVerifiedIfActive: (businessId, input) => {
      if (!input.connectionId || !input.externalTenantId || !input.externalAccountId) {
        throw new Error("Polling delivery is missing its Connection identity");
      }
      return stores.polling.recordVerifiedIfActive(
        {
          businessId,
          connectionId: input.connectionId,
          integrationId: input.integrationId,
          integrationMajorVersion: input.integrationMajorVersion,
          externalTenantId: input.externalTenantId,
          externalAccountId: input.externalAccountId,
        },
        input
      );
    },
    encryptPayload: (payload) => host.encryptPayload(payload),
    now: identifiers.now,
    newDeliveryId: identifiers.newId,
    newLeaseToken: identifiers.newId,
  };
}

export function createOimKnowledgeApi(
  registration: Pick<OimKnowledgeRegistration, "manifestDigest" | "options" | "verifiedIdentity">,
  plan: Pick<KnowledgeProfilePlan, "integrationId" | "majorVersion">,
  host: Pick<OimWorkerHost, "executeKnowledgeOperation">
): OimKnowledgeApiPort {
  return {
    connection: {
      businessId: registration.options.businessId,
      connectionId: registration.options.connectionId,
      integrationId: plan.integrationId,
      integrationMajorVersion: plan.majorVersion,
      externalTenantId: registration.verifiedIdentity.externalTenantId,
      externalAccountId: registration.verifiedIdentity.externalAccountId,
    },
    execute: (input) =>
      host.executeKnowledgeOperation({
        businessId: registration.options.businessId,
        connectionId: registration.options.connectionId,
        integrationId: plan.integrationId,
        integrationMajorVersion: plan.majorVersion,
        operationId: input.operationId,
        expectedManifestDigest: registration.manifestDigest,
        parameters: input.parameters,
        pageToken: input.pageToken,
        purpose: "knowledge_sync",
      }),
  };
}

function createDeliveryDeps(
  stores: OimStores,
  host: OimWorkerHost,
  identifiers: {
    readonly now: () => Date;
    readonly newId: () => string;
  }
): Parameters<typeof drainInbox>[0] {
  return {
    inbox: stores.inbox,
    manifestFor: (businessId, integrationId, integrationMajorVersion) =>
      host.resolveIntegrationManifest({
        businessId,
        integrationId,
        integrationMajorVersion,
      }),
    decryptPayload: (encryptedPayload) => host.decryptPayload(encryptedPayload),
    hookRunnerFor: async (context) => ({
      run: (hook, phaseInput) =>
        host.runHook({
          ...context,
          hook,
          phaseInput,
        }),
    }),
    emitIfAuthorized: async (event, fence) => {
      if (!event.connectionId || !event.externalTenantId || !event.externalAccountId) {
        throw new Error("Verified OIM delivery is missing its Connection identity fence");
      }
      const data = requireObject(event.payload, "normalized OIM event payload");
      const now = identifiers.now().toISOString();
      const result = await stores.emissions.emitIfAuthorized({
        businessId: event.businessId,
        deliveryId: event.deliveryId,
        expectedAttempts: fence.expectedAttempts,
        expectedLeaseExpiresAt: fence.expectedLeaseExpiresAt,
        connectionId: event.connectionId,
        integrationId: event.integrationId,
        integrationMajorVersion: event.integrationMajorVersion,
        externalTenantId: event.externalTenantId,
        externalAccountId: event.externalAccountId,
        event: {
          eventId: identifiers.newId(),
          type: event.type,
          version: 1,
          occurredAt: now,
          receivedAt: now,
          businessId: event.businessId,
          source: {
            provider: event.integrationId,
            integrationId: event.integrationId,
            externalTenantId: event.externalTenantId,
            deliveryId: event.deliveryId,
          },
          principal: {
            kind: "integration_account",
            externalId: event.externalAccountId,
          },
          record: {
            type: "connection",
            id: event.connectionId,
            version: String(event.integrationMajorVersion),
          },
          deduplicationKey: `${event.integrationId}:${event.deliveryId}`,
          classification: [],
          data,
          verification: {
            status: "verified",
            method: "oim_ingress",
          },
        },
      });
      return result.kind;
    },
    now: identifiers.now,
  };
}

function createKnowledgeRegistrations(
  registrations: readonly OimKnowledgeRegistration[],
  stores: OimStores,
  host: OimWorkerHost,
  identifiers: {
    readonly now: () => Date;
    readonly newId: () => string;
  }
): readonly OimKnowledgeSyncRegistration[] {
  return registrations.map((registration) => ({
    id: registration.id,
    sync: async () => {
      const plan = compileKnowledgeProfile(registration.manifest);
      return syncOimKnowledge(
        plan,
        {
          api: createOimKnowledgeApi(registration, plan, host),
          checkpoints: stores.knowledgeCheckpoints,
          publications: stores.knowledgePublications,
          connections: stores.connections,
          connectionIdentities: stores.identities,
          identity: {
            resolve: (input) => host.resolveKnowledgeIdentities(input, input.entries),
          },
          now: identifiers.now,
          newId: identifiers.newId,
        },
        registration.options
      );
    },
  }));
}

function isConnectionUsable(
  connection: {
    readonly status: "active" | "revoked";
    readonly health: {
      readonly status: "healthy" | "expiring" | "action_required" | "unknown";
    };
    readonly expiresAt: string | null;
  },
  now: Date
): boolean {
  if (
    connection.status !== "active" ||
    (connection.health.status !== "healthy" && connection.health.status !== "expiring")
  ) {
    return false;
  }
  return !connection.expiresAt || Date.parse(connection.expiresAt) > now.getTime();
}

function sameVerifiedIdentity(
  expected: {
    readonly externalTenantId: string;
    readonly externalAccountId: string;
  },
  actual: {
    readonly externalTenantId: string;
    readonly externalAccountId: string;
  }
): boolean {
  return (
    expected.externalTenantId === actual.externalTenantId &&
    expected.externalAccountId === actual.externalAccountId
  );
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}
