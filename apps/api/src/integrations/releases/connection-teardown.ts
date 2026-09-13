import { type ConnectionCredentialVault, revokeOimConnection } from "@tulipfarm/integrations";
import type { ConnectionStore } from "@tulipfarm/storage";

export interface OimReleaseConnectionScope {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
  readonly installationId: string;
  readonly slug: string;
  readonly packageDigest: string;
  readonly soulRevision: string;
}

export interface OimReleaseConnection extends OimReleaseConnectionScope {
  readonly connectionId: string;
}

export function createOimReleaseConnectionTeardown(input: {
  readonly connections: Pick<ConnectionStore, "fenceRevocation" | "listForIntegration">;
  readonly credentials: Pick<ConnectionCredentialVault, "revokeConnection">;
}) {
  return Object.freeze({
    async listConnections(
      scope: OimReleaseConnectionScope
    ): Promise<readonly OimReleaseConnection[]> {
      const connections = await input.connections.listForIntegration(scope.businessId, {
        id: scope.integrationId,
        majorVersion: scope.majorVersion,
      });
      return connections.map((connection) => ({
        ...scope,
        connectionId: connection.id,
      }));
    },

    async revokeConnection(connection: OimReleaseConnection): Promise<void> {
      const rows = await input.connections.listForIntegration(connection.businessId, {
        id: connection.integrationId,
        majorVersion: connection.majorVersion,
      });
      const persisted = rows.find((row) => row.id === connection.connectionId);
      if (persisted === undefined) return;
      await revokeOimConnection(
        {
          connections: input.connections,
          credentials: input.credentials,
        },
        persisted
      );
    },
  });
}
