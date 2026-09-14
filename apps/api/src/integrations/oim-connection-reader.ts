import {
  type ConnectionReader,
  type OimPackageCatalogEntry,
  resolveOimPackage,
} from "@tulipfarm/integrations";
import type { OimConnectionVerificationEvidence } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import type { OimPackageCatalogReader } from "./oim-catalog";

interface ConnectionTeardownStatus {
  isDisabled(businessId: string, connectionId: string): Promise<boolean>;
}

interface ConnectionVerificationEvidenceReader {
  findCurrentForConnection(
    businessId: string,
    connectionId: string,
    packageDigest: string
  ): Promise<OimConnectionVerificationEvidence | null>;
}

export function createOimAvailableConnectionReader(
  connections: ConnectionReader,
  teardown: ConnectionTeardownStatus,
  catalog: readonly OimPackageCatalogEntry[] | OimPackageCatalogReader,
  verificationEvidence: ConnectionVerificationEvidenceReader
): ConnectionReader {
  async function isAvailable(
    businessId: string,
    connection: PersistedConnection
  ): Promise<boolean> {
    if (await teardown.isDisabled(businessId, connection.id)) return false;
    const entries = typeof catalog === "function" ? catalog() : catalog;
    const packages = entries.map((entry) => resolveOimPackage([entry], entry.key));
    const pkg = packages.find(
      (entry) =>
        entry?.identity.id === connection.integration.id &&
        entry.identity.majorVersion === connection.integration.majorVersion
    );
    if (pkg === undefined) return false;
    if (pkg.manifest.auth?.verification === undefined) return true;
    return (
      (await verificationEvidence.findCurrentForConnection(
        businessId,
        connection.id,
        pkg.packageDigest
      )) !== null
    );
  }

  async function available(
    businessId: string,
    rows: readonly PersistedConnection[]
  ): Promise<PersistedConnection[]> {
    const decisions = await Promise.all(
      rows.map(async (connection) => ({
        connection,
        available: await isAvailable(businessId, connection),
      }))
    );
    return decisions.filter((decision) => decision.available).map(({ connection }) => connection);
  }

  return {
    async findById(businessId, id) {
      const connection = await connections.findById(businessId, id);
      if (connection === null || !(await isAvailable(businessId, connection))) return null;
      return connection;
    },
    async listForOwner(businessId, integration, owner) {
      return available(businessId, await connections.listForOwner(businessId, integration, owner));
    },
    async listForIntegration(businessId, integration) {
      return available(businessId, await connections.listForIntegration(businessId, integration));
    },
  };
}
