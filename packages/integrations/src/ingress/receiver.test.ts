import { createHmac } from "node:crypto";
import type { OimManifest } from "@tulipfarm/schema";
import type { RecordedDelivery, VerifiedWebhookDeliveryInput } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  type ReceiveOimDeliveryDeps,
  receiveOimDelivery,
  type WebhookIngressBinding,
} from "./receiver";

const SECRET = "verified-webhook-secret";

const manifest = {
  metadata: { id: "acme", version: "2.4.0" },
  events: {
    path: "/events",
    verification: {
      scheme: "hmac_sha256",
      secretSlot: "webhook_secret",
      signatureHeader: "x-signature",
      signatureEncoding: "hex",
    },
    deduplication: { kind: "delivery_id_header", header: "x-delivery-id" },
    eventTypes: [
      {
        type: "ticket.created",
        selector: { pointer: "/type", equals: "ticket_created" },
        schema: { type: "object" },
      },
    ],
  },
} as unknown as OimManifest;

function binding(connectionId = "connection-a", majorVersion = 2): WebhookIngressBinding {
  return {
    businessId: "business-1",
    integrationKey: `acme-v${majorVersion}`,
    integrationId: "acme",
    integrationMajorVersion: majorVersion,
    connectionId,
    manifest: {
      ...manifest,
      metadata: { ...manifest.metadata, version: `${majorVersion}.4.0` },
    },
    callbackUrl: `https://api.example.test/api/v1/hooks/oim/acme-v${majorVersion}/${connectionId}`,
    registrationRevision: 3,
    manifestDigest: "a".repeat(64),
    configurationDigest: "b".repeat(64),
    secretSlot: "webhook_secret",
    secretRef: `secret://${connectionId}`,
    verifiedIdentity: {
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    },
  };
}

function signed(body: unknown, deliveryId = "provider-42") {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      "x-delivery-id": deliveryId,
      "x-signature": createHmac("sha256", SECRET).update(rawBody).digest("hex"),
    },
  };
}

function deps(
  routeBinding: WebhookIngressBinding,
  recordVerified: (
    businessId: string,
    input: VerifiedWebhookDeliveryInput
  ) => Promise<RecordedDelivery>
): ReceiveOimDeliveryDeps {
  return {
    resolveBinding: async () => routeBinding,
    useVerificationSecret: async (_binding, use) => use(SECRET),
    verifyProviderIdentity: async () => ({
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
    }),
    reauthorizeBinding: async () => true,
    encryptPayload: async (raw) => `enc:${raw.toString("base64")}`,
    recordVerifiedIfActive: async (_binding, input) => recordVerified(_binding.businessId, input),
    newDeliveryId: () => crypto.randomUUID(),
  };
}

function recorded(input: VerifiedWebhookDeliveryInput): RecordedDelivery {
  return {
    accepted: true,
    delivery: {
      businessId: "business-1",
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

describe("receiveOimDelivery", () => {
  it("persists only verified evidence under the exact route identity", async () => {
    const recordVerified = vi.fn(async (_businessId, input: VerifiedWebhookDeliveryInput) =>
      recorded(input)
    );
    const delivery = signed({ type: "ticket_created" });

    const result = await receiveOimDelivery(
      {
        route: { integrationKey: "acme-v2", connectionId: "connection-a" },
        ...delivery,
      },
      deps(binding(), recordVerified)
    );

    expect(result).toMatchObject({ kind: "accepted", duplicate: false });
    expect(recordVerified).toHaveBeenCalledWith(
      "business-1",
      expect.objectContaining({
        integrationId: "acme",
        integrationMajorVersion: 2,
        connectionId: "connection-a",
        deduplicationKey: "provider-42",
        verification: "verified",
        authenticatedEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
  });

  it("allows the same provider delivery id for another Connection and major", async () => {
    const rows = new Map<string, VerifiedWebhookDeliveryInput>();
    const recordVerified = vi.fn(async (businessId, input: VerifiedWebhookDeliveryInput) => {
      const key = [
        businessId,
        input.integrationId,
        input.integrationMajorVersion,
        input.connectionId,
        input.deduplicationKey,
      ].join(":");
      const prior = rows.get(key);
      if (prior) return { ...recorded(prior), accepted: false };
      rows.set(key, input);
      return recorded(input);
    });
    const delivery = signed({ type: "ticket_created" });

    const first = await receiveOimDelivery(
      { route: { integrationKey: "acme-v2", connectionId: "connection-a" }, ...delivery },
      deps(binding("connection-a", 2), recordVerified)
    );
    const second = await receiveOimDelivery(
      { route: { integrationKey: "acme-v3", connectionId: "connection-b" }, ...delivery },
      deps(binding("connection-b", 3), recordVerified)
    );

    expect(first).toMatchObject({ kind: "accepted", duplicate: false });
    expect(second).toMatchObject({ kind: "accepted", duplicate: false });
    expect(recordVerified).toHaveBeenCalledTimes(2);
  });

  it("deduplicates replayed authenticated evidence even when an unsigned delivery id changes", async () => {
    let first: VerifiedWebhookDeliveryInput | undefined;
    const recordVerified = vi.fn(async (_businessId, input: VerifiedWebhookDeliveryInput) => {
      if (first === undefined) {
        first = input;
        return recorded(input);
      }
      expect(input.authenticatedEvidenceDigest).toBe(first.authenticatedEvidenceDigest);
      return { ...recorded(first), accepted: false };
    });
    const payload = { type: "ticket_created" };

    await receiveOimDelivery(
      {
        route: { integrationKey: "acme-v2", connectionId: "connection-a" },
        ...signed(payload, "unsigned-a"),
      },
      deps(binding(), recordVerified)
    );
    const replay = await receiveOimDelivery(
      {
        route: { integrationKey: "acme-v2", connectionId: "connection-a" },
        ...signed(payload, "unsigned-b"),
      },
      deps(binding(), recordVerified)
    );

    expect(replay).toMatchObject({ kind: "accepted", duplicate: true });
  });

  it("has zero identity, reauthorization, encryption, or storage effects for unsigned input", async () => {
    const recordVerified = vi.fn();
    const dependencies = deps(binding(), recordVerified);
    const verifyProviderIdentity = vi.spyOn(dependencies, "verifyProviderIdentity");
    const reauthorizeBinding = vi.spyOn(dependencies, "reauthorizeBinding");
    const encryptPayload = vi.spyOn(dependencies, "encryptPayload");

    const result = await receiveOimDelivery(
      {
        route: { integrationKey: "acme-v2", connectionId: "connection-a" },
        rawBody: Buffer.from('{"type":"ticket_created"}'),
        headers: {
          "x-delivery-id": "claimed",
          "x-timestamp": String(Date.now()),
        },
      },
      dependencies
    );

    expect(result).toEqual({ kind: "unverified", reason: "missing_signature" });
    expect(verifyProviderIdentity).not.toHaveBeenCalled();
    expect(reauthorizeBinding).not.toHaveBeenCalled();
    expect(encryptPayload).not.toHaveBeenCalled();
    expect(recordVerified).not.toHaveBeenCalled();
  });

  it("rejects a provider identity mismatch before persistence", async () => {
    const recordVerified = vi.fn();
    const dependencies = {
      ...deps(binding(), recordVerified),
      verifyProviderIdentity: async () => ({
        externalTenantId: "tenant-2",
        externalAccountId: "account-1",
      }),
    };

    const result = await receiveOimDelivery(
      {
        route: { integrationKey: "acme-v2", connectionId: "connection-a" },
        ...signed({ type: "ticket_created" }),
      },
      dependencies
    );

    expect(result).toEqual({ kind: "unverified", reason: "provider_identity_mismatch" });
    expect(recordVerified).not.toHaveBeenCalled();
  });

  it("rejects removal that races verification before encrypting or persisting", async () => {
    const recordVerified = vi.fn();
    const dependencies = {
      ...deps(binding(), recordVerified),
      reauthorizeBinding: async () => false,
    };
    const encryptPayload = vi.spyOn(dependencies, "encryptPayload");

    const result = await receiveOimDelivery(
      {
        route: { integrationKey: "acme-v2", connectionId: "connection-a" },
        ...signed({ type: "ticket_created" }),
      },
      dependencies
    );

    expect(result).toEqual({ kind: "unavailable", reason: "binding_inactive" });
    expect(encryptPayload).not.toHaveBeenCalled();
    expect(recordVerified).not.toHaveBeenCalled();
  });
});
