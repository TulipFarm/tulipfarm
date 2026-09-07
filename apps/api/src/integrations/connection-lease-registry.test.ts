import {
  type ConnectionSecretScope,
  inMemorySecretProvider,
  SecretBroker,
} from "@tulipfarm/secrets";
import { describe, expect, it, vi } from "vitest";
import { ConnectionLeaseRegistry } from "./connection-lease-registry";

describe("ConnectionLeaseRegistry", () => {
  it("revokes an issued Connection lease without deleting its Secret", async () => {
    const secretRef = "secret://connections/personal/api_key" as const;
    const provider = inMemorySecretProvider({ [secretRef]: "personal-secret" });
    const broker = new SecretBroker({
      provider,
      authorizer: { authorize: () => ({ allowed: true }) },
    });
    const scope: ConnectionSecretScope = {
      secretRef,
      connectionId: "connection-1",
      credentialSlot: "api_key",
      integrationId: "example",
      toolId: "example.request",
      runId: "run-1",
      purpose: "integration.request",
    };
    const lease = await broker.leaseConnection({ scope });
    const registry = new ConnectionLeaseRegistry("business-1");
    registry.track(broker);

    await registry.revokeConnectionLeases({
      businessId: "business-1",
      connectionId: "connection-1",
    });

    await expect(lease.use(() => "used", scope)).rejects.toMatchObject({ reason: "revoked" });
    await expect(provider.resolveCurrent(secretRef)).resolves.toMatchObject({
      value: "personal-secret",
    });
  });

  it("revokes every currently registered broker in its deployment", async () => {
    const first = { revokeConnection: vi.fn() };
    const second = { revokeConnection: vi.fn() };
    const registry = new ConnectionLeaseRegistry("business-1");
    registry.track(first);
    registry.track(second);

    await registry.revokeConnectionLeases({
      businessId: "business-1",
      connectionId: "connection-1",
    });

    expect(first.revokeConnection).toHaveBeenCalledWith("connection-1");
    expect(second.revokeConnection).toHaveBeenCalledWith("connection-1");
  });

  it("stops retaining a broker after its registration is released", async () => {
    const broker = { revokeConnection: vi.fn() };
    const registry = new ConnectionLeaseRegistry("business-1");
    const release = registry.track(broker);
    release();
    release();

    await registry.revokeConnectionLeases({
      businessId: "business-1",
      connectionId: "connection-1",
    });

    expect(broker.revokeConnection).not.toHaveBeenCalled();
  });

  it("cannot revoke brokers registered for another deployment", async () => {
    const broker = { revokeConnection: vi.fn() };
    const registry = new ConnectionLeaseRegistry("business-1");
    registry.track(broker);

    await expect(
      registry.revokeConnectionLeases({
        businessId: "business-2",
        connectionId: "connection-1",
      })
    ).rejects.toThrow("deployment");
    expect(broker.revokeConnection).not.toHaveBeenCalled();
  });

  it("preserves every broker failure after attempting all revocations", async () => {
    const firstError = new Error("first registry failed");
    const secondError = new Error("second registry failed");
    const registry = new ConnectionLeaseRegistry("business-1");
    const first = {
      revokeConnection: () => {
        throw firstError;
      },
    };
    const second = {
      revokeConnection: () => {
        throw secondError;
      },
    };
    registry.track(first);
    registry.track(second);

    const error = await registry
      .revokeConnectionLeases({
        businessId: "business-1",
        connectionId: "connection-1",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstError, secondError]);
  });
});
