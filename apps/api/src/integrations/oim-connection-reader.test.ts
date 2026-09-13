import type { ConnectionReader, OimPackageCatalogEntry } from "@tulipfarm/integrations";
import type { OimConnectionVerificationEvidence } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { createOimAvailableConnectionReader } from "./oim-connection-reader";

const packageDigest = "a".repeat(64);
const BUSINESS_ID = "business-1";
const catalog = [
  {
    key: "acme",
    packageDigest,
    manifest: {
      metadata: { id: "acme", version: "1.0.0" },
      auth: { verification: {} },
    },
  },
] as unknown as readonly OimPackageCatalogEntry[];

function connection(id: string): PersistedConnection {
  return {
    businessId: "business-1",
    id,
    integration: { id: "acme", majorVersion: 1 },
    label: id,
    owner: { scope: "organization" },
    status: "active",
    isDefault: id === "available",
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {},
    health: { status: "healthy", checkedAt: "2026-09-14T00:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-14T00:00:00.000Z"),
    updatedAt: new Date("2026-09-14T00:00:00.000Z"),
  };
}

describe("createOimAvailableConnectionReader", () => {
  it("excludes disconnecting and unverified Connections from operation reads", async () => {
    const rows = [connection("available"), connection("disconnecting"), connection("unverified")];
    const source: ConnectionReader = {
      async findById(_businessId, id) {
        return rows.find((row) => row.id === id) ?? null;
      },
      async listForOwner() {
        return rows;
      },
      async listForIntegration() {
        return rows;
      },
    };
    const reader = createOimAvailableConnectionReader(
      source,
      {
        async isDisabled(_businessId, connectionId) {
          return connectionId === "disconnecting";
        },
      },
      catalog,
      {
        async findCurrentForConnection(_businessId, connectionId, expectedPackageDigest) {
          if (connectionId !== "available" || expectedPackageDigest !== packageDigest) return null;
          return {
            assurance: "validity_only",
            subject: null,
            tenant: null,
            issuer: "https://api.example.com",
            binding: {
              businessId: "business-1",
              connectionId,
              integrationId: "acme",
              integrationMajorVersion: 1,
              packageDigest,
              configurationDigest: "b".repeat(64),
              authSteps: [],
            },
            proofDigest: "c".repeat(64),
            verifiedAt: "2026-09-14T00:00:00.000Z",
            verifiedBy: "oim-auth-1.1",
          } satisfies OimConnectionVerificationEvidence;
        },
      }
    );

    await expect(reader.findById("business-1", "disconnecting")).resolves.toBeNull();
    await expect(reader.findById("business-1", "unverified")).resolves.toBeNull();
    await expect(
      reader.listForOwner(
        "business-1",
        { id: "acme", majorVersion: 1 },
        {
          scope: "organization",
        }
      )
    ).resolves.toEqual([rows[0]]);
    await expect(
      reader.listForIntegration("business-1", { id: "acme", majorVersion: 1 })
    ).resolves.toEqual([rows[0]]);
  });

  it("reads the current package catalog for every availability decision", async () => {
    const row = connection("available");
    const source: ConnectionReader = {
      async findById() {
        return row;
      },
      async listForOwner() {
        return [row];
      },
      async listForIntegration() {
        return [row];
      },
    };
    let current: readonly OimPackageCatalogEntry[] = [];
    const reader = createOimAvailableConnectionReader(
      source,
      {
        async isDisabled() {
          return false;
        },
      },
      () => current,
      {
        async findCurrentForConnection() {
          return {} as OimConnectionVerificationEvidence;
        },
      }
    );

    await expect(reader.findById(BUSINESS_ID, row.id)).resolves.toBeNull();
    current = catalog;
    await expect(reader.findById(BUSINESS_ID, row.id)).resolves.toBe(row);
  });
});
