import type { OimManifest, OimPollingIngress } from "@tulipfarm/schema";
import type { RecordedDelivery, VerifiedWebhookDeliveryInput } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type PollingIngressKey,
  type PollOimIngressDeps,
  pollOimIngress,
  type ResolvedPollingIngress,
} from "./polling-service";

const ingress: OimPollingIngress = {
  kind: "polling",
  operationId: "list_events",
  intervalSeconds: 60,
  eventTypes: [
    {
      type: "ticket.created",
      selector: { pointer: "/type", equals: "ticket_created" },
      schema: { type: "object" },
    },
  ],
  cursor: {
    mode: "max_integer_plus_one",
    responsePointer: "/items",
    itemPointer: "/id",
    requestParameter: "after",
  },
};

function key(connectionId: string, majorVersion = 2): PollingIngressKey {
  return {
    businessId: "business-1",
    connectionId,
    integrationId: "acme",
    integrationMajorVersion: majorVersion,
  };
}

function source(input: PollingIngressKey): ResolvedPollingIngress {
  return {
    ...input,
    manifest: {
      metadata: { id: "acme", version: `${input.integrationMajorVersion}.0.0` },
      ingress,
    } as unknown as OimManifest,
    ingress,
    eventTypes: ingress.eventTypes ?? [],
    verifiedIdentity: {
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    },
  };
}

function recorded(
  businessId: string,
  input: VerifiedWebhookDeliveryInput,
  accepted = true
): RecordedDelivery {
  return {
    accepted,
    delivery: {
      businessId,
      ...input,
      state: "accepted",
      attempts: 0,
      lastError: null,
      normalizedPayload: null,
      replayOfId: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(),
      leaseExpiresAt: null,
      rawDeletedAt: null,
    },
  };
}

describe("pollOimIngress", () => {
  let recordVerifiedIfActive: Mock<PollOimIngressDeps["recordVerifiedIfActive"]>;
  let release: Mock<PollOimIngressDeps["state"]["release"]>;
  let execute: Mock<PollOimIngressDeps["execute"]>;

  function deps(candidates: readonly PollingIngressKey[]): PollOimIngressDeps {
    return {
      candidates: async () => candidates,
      resolveSource: async (candidate) => source(candidate),
      execute,
      reauthorizeSource: async () => true,
      state: {
        claim: async () => ({ cursor: "100" }),
        complete: async () => true,
        release,
      },
      recordVerifiedIfActive,
      encryptPayload: async (raw) => `enc:${raw.toString("base64")}`,
      newDeliveryId: () => crypto.randomUUID(),
      newLeaseToken: () => crypto.randomUUID(),
    };
  }

  beforeEach(() => {
    const seen = new Map<string, VerifiedWebhookDeliveryInput>();
    recordVerifiedIfActive = vi.fn(async (businessId, input: VerifiedWebhookDeliveryInput) => {
      const route = [
        businessId,
        input.integrationId,
        input.integrationMajorVersion,
        input.connectionId,
        input.deduplicationKey,
      ].join(":");
      const prior = seen.get(route);
      if (prior !== undefined) return recorded(businessId, prior, false);
      seen.set(route, input);
      return recorded(businessId, input);
    });
    release = vi.fn(async () => true);
    execute = vi.fn(async () => ({
      response: { items: [{ id: 101, type: "ticket_created" }] },
      authenticatedEvidenceDigest: "a".repeat(64),
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
      },
    }));
  });

  it("persists the same provider item independently for exact Connections and majors", async () => {
    const summary = await pollOimIngress(deps([key("connection-a", 2), key("connection-b", 3)]));

    expect(summary).toEqual({
      candidates: 2,
      claimed: 2,
      recorded: 2,
      duplicates: 0,
      failed: 0,
      failures: [],
    });
    expect(recordVerifiedIfActive.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        integrationMajorVersion: 2,
        connectionId: "connection-a",
        verification: "verified_polling",
      }),
      expect.objectContaining({
        integrationMajorVersion: 3,
        connectionId: "connection-b",
        verification: "verified_polling",
      }),
    ]);
  });

  it("deduplicates an exact polling route and authenticated response item", async () => {
    const dependencies = deps([key("connection-a")]);
    const first = await pollOimIngress(dependencies);
    const second = await pollOimIngress(dependencies);

    expect(first.recorded).toBe(1);
    expect(second.duplicates).toBe(1);
  });

  it("records nothing when revoke wins while the provider request is in flight", async () => {
    let finish!: () => void;
    const providerFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    execute.mockImplementationOnce(async () => {
      await providerFinished;
      return {
        response: { items: [{ id: 101, type: "ticket_created" }] },
        authenticatedEvidenceDigest: "a".repeat(64),
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
        },
      };
    });
    let authorized = true;
    const dependencies = {
      ...deps([key("connection-a")]),
      reauthorizeSource: async () => authorized,
    };

    const polling = pollOimIngress(dependencies);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    authorized = false;
    finish();
    const result = await polling;

    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([{ key: key("connection-a"), code: "source_revoked" }]);
    expect(recordVerifiedIfActive).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched trusted provider identity before persistence", async () => {
    execute.mockResolvedValueOnce({
      response: { items: [{ id: 101, type: "ticket_created" }] },
      authenticatedEvidenceDigest: "b".repeat(64),
      verifiedIdentity: {
        externalTenantId: "other-tenant",
        externalAccountId: "account-1",
      },
    });

    const result = await pollOimIngress(deps([key("connection-a")]));

    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      { key: key("connection-a"), code: "provider_identity_unverified" },
    ]);
    expect(recordVerifiedIfActive).not.toHaveBeenCalled();
  });
});
