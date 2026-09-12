import { describe, expect, it, vi } from "vitest";
import { SecretBroker } from "./broker";
import { ConnectionSecretManager, secretStorageKey } from "./connection-secrets";
import { type SecretProvider, secretsServiceProvider } from "./providers";

const ACCESS_REF = "secret://00000000-0000-4000-8000-000000000001";
const REFRESH_REF = "secret://00000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "connection-1";

function harness() {
  const values = new Map([
    [secretStorageKey(ACCESS_REF), { value: "access", revision: "1" }],
    [secretStorageKey(REFRESH_REF), { value: "refresh", revision: "1" }],
  ]);
  const provider: SecretProvider = {
    async resolveCurrent(secretRef) {
      const secret = values.get(secretStorageKey(secretRef));
      return secret === undefined ? null : { value: secret.value, version: secret.revision };
    },
    async resolveUncached(secretRef) {
      const secret = values.get(secretStorageKey(secretRef));
      return secret === undefined ? null : { value: secret.value, version: secret.revision };
    },
    async currentVersion(secretRef) {
      return values.get(secretStorageKey(secretRef))?.revision ?? null;
    },
  };
  const broker = new SecretBroker({
    provider,
    authorizer: { authorize: () => ({ allowed: true }) },
  });
  const manager = new ConnectionSecretManager(
    {
      async set(key, plaintext) {
        const previous = values.get(key);
        values.set(key, {
          value: plaintext,
          revision: String(Number(previous?.revision ?? "0") + 1),
        });
      },
      async delete(key) {
        values.delete(key);
      },
    },
    broker
  );
  return { broker, manager, values };
}

function scope(secretRef: `secret://${string}`, credentialSlot: string) {
  return {
    secretRef,
    connectionId: CONNECTION_ID,
    credentialSlot,
    toolId: "oim.calendar.v2.events.list",
    integrationId: "calendar",
    runId: "run-1",
    purpose: "read calendar",
  } as const;
}

describe("Connection Secret leases", () => {
  it("uses cached service semantics only for legacy leases", async () => {
    const get = vi.fn(async () => "legacy-cached");
    const resolveCurrent = vi.fn(async () => ({ value: "connection-current", version: "7" }));
    const provider = secretsServiceProvider({
      get,
      resolveCurrent,
      revision: async () => "7",
    });
    const broker = new SecretBroker({
      provider,
      authorizer: { authorize: () => ({ allowed: true }) },
    });
    const legacy = await broker.lease({
      scope: {
        secretRef: "legacy.key",
        toolId: "legacy.tool",
        runId: "run-1",
        purpose: "legacy call",
      },
    });
    const connection = await broker.leaseConnection({
      scope: scope(ACCESS_REF, "access"),
    });

    await expect(legacy.use((plaintext) => plaintext === "legacy-cached")).resolves.toBe(true);
    await expect(connection.use((plaintext) => plaintext === "connection-current")).resolves.toBe(
      true
    );
    expect(get).toHaveBeenCalledWith("legacy.key");
    expect(resolveCurrent).toHaveBeenCalledWith(secretStorageKey(ACCESS_REF));
  });

  it("rejects a lease after its exact Secret rotates", async () => {
    const { broker, manager } = harness();
    const lease = await broker.leaseConnection({
      scope: scope(ACCESS_REF, "access"),
      maxUses: 2,
    });

    await manager.rotate(ACCESS_REF, "new-access");

    await expect(lease.use(() => "used")).rejects.toMatchObject({ reason: "revoked" });
  });

  it("revokes every bound lease when the Connection is revoked", async () => {
    const { broker, manager, values } = harness();
    const leases = await broker.leaseConnectionSet({
      access: { scope: scope(ACCESS_REF, "access") },
      refresh: { scope: scope(REFRESH_REF, "refresh") },
    });

    await manager.revokeConnection(
      CONNECTION_ID,
      { access: ACCESS_REF, refresh: REFRESH_REF },
      async () => {}
    );

    expect(values.size).toBe(0);
    await expect(leases.use(() => "used")).rejects.toMatchObject({ reason: "revoked" });
  });

  it("keeps plaintext inside the lease callback", async () => {
    const { broker } = harness();
    const lease = await broker.leaseConnection({ scope: scope(ACCESS_REF, "access") });

    await expect(lease.use((plaintext) => plaintext)).rejects.toMatchObject({
      name: "SecretLeakError",
    });
  });
});
