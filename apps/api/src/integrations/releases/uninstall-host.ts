import { randomUUID } from "node:crypto";
import {
  type ConnectionCredentialVault,
  OimIngressTeardownService,
  type OimUninstallHost,
  type OimUninstallTarget,
  teardownOimKnowledge,
} from "@tulipfarm/integrations";
import type {
  ConnectionStore,
  IngressTeardownStore,
  OimKnowledgeCheckpointStore,
  OimKnowledgePublicationStore,
  OimReleaseDispatchLeaseStore,
  OimReleaseTrustStore,
  PollingIngressStore,
  WebhookRegistrationStore,
} from "@tulipfarm/storage";
import { createOimReleaseConnectionTeardown } from "./connection-teardown";

export interface OimReleaseUninstallHostDeps {
  readonly connections: Pick<ConnectionStore, "fenceRevocation" | "listForIntegration">;
  readonly credentials: Pick<ConnectionCredentialVault, "revokeConnection">;
  readonly ingressTeardowns: Pick<IngressTeardownStore, "disable">;
  readonly polling: Pick<PollingIngressStore, "remove">;
  readonly webhooks: Pick<WebhookRegistrationStore, "requestRemoval">;
  readonly dispatchLeases: Pick<OimReleaseDispatchLeaseStore, "listUnresolved">;
  readonly knowledgePublications: Pick<OimKnowledgePublicationStore, "tombstoneConnection">;
  readonly knowledgeCheckpoints: Pick<OimKnowledgeCheckpointStore, "clearConnection">;
  readonly releaseTrust: Pick<OimReleaseTrustStore, "removeInstalledProvenance">;
  readonly packageWriter: {
    remove(target: OimUninstallTarget): Promise<unknown>;
  };
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function connectionKey(target: OimUninstallTarget, connectionId: string) {
  return {
    businessId: target.businessId,
    connectionId,
    integrationId: target.integrationId,
    integrationMajorVersion: target.majorVersion,
  };
}

/** Composes the durable P09 uninstall stages from the production Connection and Soul ports. */
export function createOimReleaseUninstallHost(deps: OimReleaseUninstallHostDeps): OimUninstallHost {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const connections = createOimReleaseConnectionTeardown({
    connections: deps.connections,
    credentials: deps.credentials,
  });
  const ingress = new OimIngressTeardownService(deps.ingressTeardowns, deps.polling, {
    remove: (key) => deps.webhooks.requestRemoval(key),
  });

  const host: OimUninstallHost = {
    async fenceAndDrain(target) {
      const scopedConnections = await connections.listConnections(target);
      for (const connection of scopedConnections) {
        const disabled = await deps.ingressTeardowns.disable(
          connectionKey(target, connection.connectionId),
          now()
        );
        if (!disabled) throw new Error("oim_release_ingress_fence_failed");
      }
      const unresolved = await deps.dispatchLeases.listUnresolved(target, now().toISOString());
      if (unresolved.length > 0) {
        throw new Error(
          `oim_release_dispatch_not_drained:${unresolved.map(({ leaseId }) => leaseId).join(",")}`
        );
      }
      return {
        toolDispatchFenced: true,
        ingressFenced: true,
        inFlightWorkDrained: true,
        inFlightWorkIds: [],
      };
    },

    async unsubscribeRemote(target) {
      const scopedConnections = await connections.listConnections(target);
      let remoteCleanupComplete = true;
      for (const connection of scopedConnections) {
        const result = await ingress.remove(connectionKey(target, connection.connectionId), now());
        remoteCleanupComplete &&= result.remoteCleanupComplete;
      }
      return { remoteCleanupComplete };
    },

    listConnections: connections.listConnections,
    revokeConnection: connections.revokeConnection,

    async removePackageOwnedState(target) {
      const scopedConnections = await connections.listConnections(target);
      for (const connection of scopedConnections) {
        await teardownOimKnowledge(connectionKey(target, connection.connectionId), {
          publications: deps.knowledgePublications,
          checkpoints: deps.knowledgeCheckpoints,
          now,
          newId,
        });
      }
    },

    async removeReleaseProvenance(target) {
      await deps.releaseTrust.removeInstalledProvenance(target);
    },

    async removeSoulPackage(target) {
      await deps.packageWriter.remove(target);
    },
  };
  return Object.freeze(host);
}
