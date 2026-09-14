import type { WebhookRegistrationKey } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { OimIngressTeardownService } from "./teardown";

const key: WebhookRegistrationKey = {
  businessId: "business-1",
  integrationId: "acme",
  integrationMajorVersion: 2,
  connectionId: "connection-1",
};

describe("OimIngressTeardownService", () => {
  it("blocks new ingress before removing local polling and remote webhook state", async () => {
    const order: string[] = [];
    const service = new OimIngressTeardownService(
      {
        disable: vi.fn(async () => {
          order.push("disable");
          return true;
        }),
      },
      {
        remove: vi.fn(async () => {
          order.push("polling");
          return true;
        }),
      },
      {
        remove: vi.fn(async () => {
          order.push("webhook");
          return null;
        }),
      }
    );

    await expect(service.remove(key)).resolves.toEqual({
      ingressDisabled: true,
      pollingStateRemoved: true,
      webhook: null,
      remoteCleanupComplete: true,
    });
    expect(order).toEqual(["disable", "polling", "webhook"]);
  });

  it("reports durable remote cleanup failure without re-enabling ingress", async () => {
    const service = new OimIngressTeardownService(
      { disable: vi.fn(async () => true) },
      { remove: vi.fn(async () => false) },
      {
        remove: vi.fn(
          async () =>
            ({
              ...key,
              desiredState: "removed",
              state: "cleanup_failed",
              target: {
                integrationKey: "acme-v2",
                manifestDigest: "a".repeat(64),
                stepId: "webhook",
                callbackUrl: "https://api.example.test/api/v1/hooks/oim/acme-v2/connection-1",
                operationId: "register",
                unregisterOperationId: "remove",
                secretSlot: "webhook_secret",
                packageSnapshot: {
                  integrationId: "acme",
                  version: "2.0.0",
                  majorVersion: 2,
                  packageDigest: "a".repeat(64),
                  manifestText: "{}",
                  files: [],
                },
              },
              active: {
                integrationKey: "acme-v2",
                manifestDigest: "a".repeat(64),
                stepId: "webhook",
                callbackUrl: "https://api.example.test/api/v1/hooks/oim/acme-v2/connection-1",
                operationId: "register",
                unregisterOperationId: "remove",
                secretSlot: "webhook_secret",
                packageSnapshot: {
                  integrationId: "acme",
                  version: "2.0.0",
                  majorVersion: 2,
                  packageDigest: "a".repeat(64),
                  manifestText: "{}",
                  files: [],
                },
                subscriptionId: "subscription-1",
                secretRef: "secret://webhook",
              },
              stagedSecretRef: null,
              attempts: 2,
              nextAttemptAt: new Date("2026-03-01T12:05:00.000Z"),
              leaseToken: null,
              leaseExpiresAt: null,
              lastError: "provider_unavailable",
              generation: 1,
              revision: 4,
              createdAt: new Date("2026-03-01T12:00:00.000Z"),
              updatedAt: new Date("2026-03-01T12:01:00.000Z"),
            }) as const
        ),
      }
    );

    await expect(service.remove(key)).resolves.toMatchObject({
      ingressDisabled: true,
      remoteCleanupComplete: false,
      webhook: { state: "cleanup_failed", lastError: "provider_unavailable" },
    });
  });
});
