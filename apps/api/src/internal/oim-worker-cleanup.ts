import {
  ConnectionResolver,
  OimOperationConnectionResolver,
  type OimReleasePackage,
  verifyOimReleasePackage,
} from "@tulipfarm/integrations";
import type { SoulIntegration } from "@tulipfarm/soul";
import type {
  ConnectionAuthStepStore,
  ConnectionStore,
  PersistedConnection,
  Queryable,
} from "@tulipfarm/storage";
import type { OimConnectionServiceDeps } from "../integrations/connections/service";
import { loadOimWebhookCleanupPackage } from "./oim-webhook-cleanup-package";
import {
  type InternalOimWorkerHostDeps,
  PgOimWebhookCleanupAuthorization,
} from "./oim-worker-host";

export interface OimWorkerCleanupServices {
  readonly registrationPackages: NonNullable<OimConnectionServiceDeps["registrationPackages"]>;
  readonly cleanupAuthorization: NonNullable<InternalOimWorkerHostDeps["cleanupAuthorization"]>;
  readonly cleanupConnectionOperations: NonNullable<
    InternalOimWorkerHostDeps["cleanupConnectionOperations"]
  >;
  readonly cleanupPackages: NonNullable<InternalOimWorkerHostDeps["cleanupPackages"]>;
}

export function createOimWorkerCleanupServices(input: {
  readonly database: Queryable;
  readonly connections: ConnectionStore;
  readonly authSteps: ConnectionAuthStepStore;
  readonly verifiedIntegrations: () => Iterable<readonly [string, SoulIntegration]>;
}): OimWorkerCleanupServices {
  /** Durable cleanup is already exact-target authorized and must outlive activation health. */
  const forCleanup = (connection: PersistedConnection): PersistedConnection => ({
    ...connection,
    health: { status: "healthy", checkedAt: connection.health.checkedAt },
    expiresAt: null,
  });
  const cleanupConnections = {
    async findById(businessId: string, id: string) {
      const connection = await input.connections.findById(businessId, id);
      return connection === null ? null : forCleanup(connection);
    },
    async listForOwner(
      businessId: string,
      integration: PersistedConnection["integration"],
      owner: PersistedConnection["owner"]
    ) {
      return (await input.connections.listForOwner(businessId, integration, owner)).map(forCleanup);
    },
    async listForIntegration(businessId: string, integration: PersistedConnection["integration"]) {
      return (await input.connections.listForIntegration(businessId, integration)).map(forCleanup);
    },
  };
  return {
    registrationPackages: {
      async packageFor(integrationKey) {
        const integration = [...input.verifiedIntegrations()].find(
          ([key]) => key === integrationKey
        )?.[1];
        if (
          integration?.oimManifest === undefined ||
          integration.slug !== integrationKey ||
          integration.sourceIntegration !== integration.oimManifest.metadata.id
        ) {
          return null;
        }
        const package_: OimReleasePackage = {
          manifest: structuredClone(integration.oimManifest),
          files: new Map(
            Object.entries(integration.oimPackageFiles ?? {}).map(([path, content]) => [
              path,
              typeof content === "string" ? content : new Uint8Array(content),
            ])
          ),
        };
        verifyOimReleasePackage(package_);
        return package_;
      },
    },
    cleanupAuthorization: new PgOimWebhookCleanupAuthorization(input.database),
    cleanupPackages: { load: loadOimWebhookCleanupPackage },
    cleanupConnectionOperations: new OimOperationConnectionResolver(
      new ConnectionResolver(cleanupConnections, {
        async canUse(principal) {
          return principal.kind === "service" && principal.id === "integration-worker";
        },
      }),
      input.authSteps
    ),
  };
}
