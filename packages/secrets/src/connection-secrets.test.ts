import { describe, expect, it } from "vitest";
import { SecretBroker } from "./broker";
import { ConnectionSecretManager, secretStorageKey } from "./connection-secrets";
import { type SecretProvider, secretsServiceProvider } from "./providers";

const SECRET_REF = "secret://00000000-0000-4000-8000-000000000003";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000001";
const SCOPE = {
  secretRef: SECRET_REF,
  connectionId: CONNECTION_ID,
  credentialSlot: "api_key",
  toolId: "oim.weather.v1.current-weather",
  integrationId: "weather",
  runId: "run-1",
  purpose: "read weather",
} as const;

function harness() {
  const values = new Map([[secretStorageKey(SECRET_REF), "original"]]);
  const provider: SecretProvider = {
    async resolveCurrent(secretRef) {
      const value = values.get(secretStorageKey(secretRef));
      return value === undefined ? null : { value, version: value };
    },
    async currentVersion(secretRef) {
      return values.get(secretStorageKey(secretRef)) ?? null;
    },
  };
  const broker = new SecretBroker({
    provider,
    authorizer: { authorize: async () => ({ allowed: true }) },
  });
  const remoteBroker = new SecretBroker({
    provider,
    authorizer: { authorize: async () => ({ allowed: true }) },
  });
  const manager = new ConnectionSecretManager(
    {
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    },
    broker
  );
  return { broker, manager, remoteBroker, values };
}

describe("ConnectionSecretManager", () => {
  it("replaces a Secret value and immediately revokes every old lease", async () => {
    const { broker, manager, remoteBroker } = harness();
    const oldLease = await remoteBroker.leaseConnection({ scope: SCOPE, maxUses: 2 });

    await manager.rotate(SECRET_REF, "rotated");

    await expect(oldLease.use(async () => "used")).rejects.toMatchObject({ reason: "revoked" });
    const newLease = await broker.leaseConnection({ scope: SCOPE });
    await expect(newLease.use(async (secret) => secret === "rotated")).resolves.toBe(true);
  });

  it("deletes bound Secrets and revokes all leases for the Connection", async () => {
    const { manager, remoteBroker, values } = harness();
    const lease = await remoteBroker.leaseConnection({ scope: SCOPE });
    let persisted = false;

    await manager.revokeConnection(CONNECTION_ID, { api_key: SECRET_REF }, async () => {
      persisted = true;
    });

    expect(values.size).toBe(0);
    expect(persisted).toBe(true);
    await expect(lease.use(async () => "used")).rejects.toMatchObject({ reason: "revoked" });
  });

  it("rejects bare keys and non-opaque path references", () => {
    expect(() => secretStorageKey("plain-key")).toThrow(/secret:\/\//);
    expect(() => secretStorageKey("secret://connections/id/key")).toThrow(/opaque/);
    expect(() => secretStorageKey("secret://constructor")).toThrow(/opaque/);
  });

  it("resolves canonical references through the opaque SecretsService key", async () => {
    const requested: string[] = [];
    const provider = secretsServiceProvider({
      resolveCurrent: async (key) => {
        requested.push(key);
        return { value: "value", version: "1" };
      },
      revision: async () => "1",
    });

    await expect(provider.resolveCurrent(SECRET_REF)).resolves.toEqual({
      value: "value",
      version: "1",
    });
    expect(requested).toEqual(["00000000-0000-4000-8000-000000000003"]);
  });
});
