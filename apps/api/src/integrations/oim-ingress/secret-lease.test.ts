import { SecretLease } from "@tulipfarm/secrets";
import { describe, expect, it, vi } from "vitest";
import { createOimWebhookSecretUser, type OimWebhookSecretLeaseDeps } from "./secret-lease";

describe("createOimWebhookSecretUser", () => {
  it("leases the exact Connection slot and revision for one callback use", async () => {
    const leaseConnection: OimWebhookSecretLeaseDeps["secrets"]["leaseConnection"] = vi.fn(
      async (request) => {
        return new SecretLease(
          "lease-1",
          request.scope,
          Date.now() + 1_000,
          async (_leaseId, _scope, callback) => callback("verification-secret")
        );
      }
    );
    const useSecret = createOimWebhookSecretUser({
      revision: async () => "revision-7",
      secrets: { leaseConnection },
    });

    await expect(
      useSecret(
        {
          businessId: "business-1",
          connectionId: "connection-1",
          integrationId: "acme",
          integrationMajorVersion: 2,
          secretSlot: "webhook_secret",
          secretRef: "secret://webhook",
          callbackUrl: "https://api.example.test/api/v1/hooks/oim/acme-v2/connection-1",
          manifestDigest: "a".repeat(64),
          configurationDigest: "b".repeat(64),
        },
        async (secret) => secret.length
      )
    ).resolves.toBe("verification-secret".length);
    expect(leaseConnection).toHaveBeenCalledWith({
      scope: expect.objectContaining({
        secretRef: "secret://webhook",
        businessId: "business-1",
        connectionId: "connection-1",
        credentialSlot: "webhook_secret",
        credentialRevision: "revision-7",
        integrationId: "acme",
        integrationMajorVersion: 2,
        operationId: "webhook.verify",
      }),
      maxUses: 1,
    });
  });

  it("does not request a lease when the Secret revision is unavailable", async () => {
    const leaseConnection = vi.fn();
    const useSecret = createOimWebhookSecretUser({
      revision: async () => null,
      secrets: { leaseConnection },
    });

    await expect(
      useSecret(
        {
          businessId: "business-1",
          connectionId: "connection-1",
          integrationId: "acme",
          integrationMajorVersion: 2,
          secretSlot: "webhook_secret",
          secretRef: "secret://webhook",
          callbackUrl: "https://api.example.test/api/v1/hooks/oim/acme-v2/connection-1",
          manifestDigest: "a".repeat(64),
          configurationDigest: "b".repeat(64),
        },
        async () => "unused"
      )
    ).rejects.toThrow("webhook_secret_unavailable");
    expect(leaseConnection).not.toHaveBeenCalled();
  });
});
