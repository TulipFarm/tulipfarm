import type { OimReleaseDispatchLease } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { createOimReleaseUninstallHost } from "./uninstall-host";

const TARGET = {
  businessId: "business-1",
  integrationId: "calendar",
  majorVersion: 2,
  installationId: "11111111-1111-4111-8111-111111111111",
  slug: "calendar-v2",
  packageDigest: "a".repeat(64),
  soulRevision: "soul-calendar",
} as const;

function dependencies() {
  const connection = {
    businessId: TARGET.businessId,
    id: "connection-1",
    integration: { id: TARGET.integrationId, majorVersion: TARGET.majorVersion },
    label: "Calendar",
    owner: { scope: "organization" as const },
    status: "active" as const,
    isDefault: false,
    configuration: {},
    agentVisibleConfiguration: [],
    secretBindings: {
      access: "secret://00000000-0000-4000-8000-000000000001" as const,
    },
    health: { status: "healthy" as const, checkedAt: "2026-09-13T09:00:00.000Z" },
    expiresAt: null,
    createdAt: new Date("2026-09-13T09:00:00.000Z"),
    updatedAt: new Date("2026-09-13T09:00:00.000Z"),
  };
  return {
    connections: {
      listForIntegration: vi.fn(async () => [connection]),
      fenceRevocation: vi.fn(async () => ({ ...connection, status: "revoked" as const })),
    },
    credentials: {
      revokeConnection: vi.fn(
        async (
          _connectionId: string,
          _bindings: Readonly<Record<string, `secret://${string}`>>,
          persist: () => Promise<void>
        ) => persist()
      ),
    },
    ingressTeardowns: {
      disable: vi.fn(async () => true),
    },
    polling: {
      remove: vi.fn(async () => true),
    },
    webhooks: {
      requestRemoval: vi.fn(async () => null),
    },
    dispatchLeases: {
      listUnresolved: vi.fn(async (): Promise<readonly OimReleaseDispatchLease[]> => []),
    },
    knowledgePublications: {
      tombstoneConnection: vi.fn(async () => ["calendar:event-1"]),
    },
    knowledgeCheckpoints: {
      clearConnection: vi.fn(async () => 1),
    },
    releaseTrust: {
      removeInstalledProvenance: vi.fn(async () => true),
    },
    packageWriter: {
      remove: vi.fn(async () => ({ revision: "soul-after", alreadyAbsent: false })),
    },
    now: () => new Date("2026-09-13T10:00:00.000Z"),
    newId: () => "delete-1",
  };
}

describe("createOimReleaseUninstallHost", () => {
  it("composes exact-scope dispatch, ingress, Connection, Knowledge, provenance, and Soul teardown", async () => {
    const deps = dependencies();
    const host = createOimReleaseUninstallHost(deps);

    await expect(host.fenceAndDrain(TARGET)).resolves.toEqual({
      toolDispatchFenced: true,
      ingressFenced: true,
      inFlightWorkDrained: true,
      inFlightWorkIds: [],
    });
    await expect(host.unsubscribeRemote(TARGET)).resolves.toEqual({
      remoteCleanupComplete: true,
    });
    const connections = await host.listConnections(TARGET);
    const connection = connections[0];
    if (connection === undefined) throw new Error("missing Connection fixture");
    await host.revokeConnection(connection);
    await host.removePackageOwnedState(TARGET);
    await host.removeReleaseProvenance(TARGET);
    await host.removeSoulPackage(TARGET);

    expect(deps.ingressTeardowns.disable).toHaveBeenCalledWith(
      {
        businessId: TARGET.businessId,
        connectionId: "connection-1",
        integrationId: TARGET.integrationId,
        integrationMajorVersion: TARGET.majorVersion,
      },
      new Date("2026-09-13T10:00:00.000Z")
    );
    expect(deps.webhooks.requestRemoval).toHaveBeenCalledOnce();
    expect(deps.credentials.revokeConnection).toHaveBeenCalledWith(
      "connection-1",
      {
        access: "secret://00000000-0000-4000-8000-000000000001",
      },
      expect.any(Function)
    );
    expect(deps.knowledgePublications.tombstoneConnection).toHaveBeenCalledWith({
      businessId: TARGET.businessId,
      connectionId: "connection-1",
      integrationId: TARGET.integrationId,
      integrationMajorVersion: TARGET.majorVersion,
      deletedRevisionPrefix: "deleted:delete-1",
      deletedAt: "2026-09-13T10:00:00.000Z",
    });
    expect(deps.knowledgeCheckpoints.clearConnection).toHaveBeenCalledWith({
      businessId: TARGET.businessId,
      connectionId: "connection-1",
      integrationId: TARGET.integrationId,
      integrationMajorVersion: TARGET.majorVersion,
    });
    expect(deps.releaseTrust.removeInstalledProvenance).toHaveBeenCalledWith(TARGET);
    expect(deps.packageWriter.remove).toHaveBeenCalledWith(TARGET);
  });

  it("fails closed while an exact-major dispatch lease remains unresolved", async () => {
    const deps = dependencies();
    deps.dispatchLeases.listUnresolved.mockResolvedValue([
      {
        leaseId: "22222222-2222-4222-8222-222222222222",
        businessId: TARGET.businessId,
        integrationId: TARGET.integrationId,
        majorVersion: TARGET.majorVersion,
        installationId: TARGET.installationId,
        packageDigest: TARGET.packageDigest,
        status: "active",
        acquiredAt: "2026-09-13T09:59:00.000Z",
        expiresAt: "2026-09-13T10:01:00.000Z",
        updatedAt: "2026-09-13T09:59:00.000Z",
      },
    ]);

    await expect(createOimReleaseUninstallHost(deps).fenceAndDrain(TARGET)).rejects.toThrow(
      "oim_release_dispatch_not_drained:22222222-2222-4222-8222-222222222222"
    );
    expect(deps.ingressTeardowns.disable).toHaveBeenCalledOnce();
  });
});
