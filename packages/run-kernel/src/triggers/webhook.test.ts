import { createHmac, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ingestWebhook,
  type RawPayloadVault,
  type WebhookEventSink,
  type WebhookIngressDeps,
  type WebhookSecretPort,
  type WebhookTrigger,
} from "./webhook";

const SECRET = "top-secret-signing-key";
const RECEIVED_AT = "2026-07-25T10:00:00.000Z";

const trigger: WebhookTrigger = {
  triggerSlug: "github-issues",
  businessId: "biz",
  provider: "github",
  eventType: "github.issues.opened",
  eventVersion: 1,
  verification: {
    method: "hmac_sha256",
    secretRef: "secret://github/webhook",
    signatureHeader: "x-provider-signature",
  },
  deliveryIdHeader: "x-provider-delivery",
  backgroundIdentity: { principalKind: "service", principalId: "webhook-ingress" },
  classification: ["internal"],
};

function sign(body: Buffer, algorithm: "sha256" | "sha1" = "sha256"): string {
  return createHmac(algorithm, SECRET).update(body).digest("hex");
}

function deps(overrides: Partial<WebhookIngressDeps> = {}): WebhookIngressDeps {
  const secrets: WebhookSecretPort = { resolve: async () => SECRET };
  const vault: RawPayloadVault = { store: async () => ({ artifactId: "artifact-1" }) };
  const sink: WebhookEventSink = { accept: async () => ({ outcome: "accepted" }) };
  return { secrets, vault, sink, nextEventId: () => "event-1", ...overrides };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      "x-provider-signature": sign(rawBody),
      "x-provider-delivery": "delivery-1",
      ...headers,
    },
    receivedAt: RECEIVED_AT,
  };
}

describe("ingestWebhook — accepted delivery", () => {
  it("persists a canonical verified envelope and only then reports acceptance", async () => {
    const order: string[] = [];
    const accept = vi.fn<WebhookEventSink["accept"]>(async () => {
      order.push("persist");
      return { outcome: "accepted" };
    });
    const store = vi.fn(async () => {
      order.push("vault");
      return { artifactId: "artifact-1" };
    });
    const result = await ingestWebhook(
      trigger,
      request({ action: "opened" }),
      deps({ sink: { accept }, vault: { store } })
    );

    expect(result).toEqual({
      status: 202,
      outcome: "accepted",
      eventId: "event-1",
      deduplicationKey: "github-issues:delivery-1",
    });
    expect(order).toEqual(["vault", "persist"]);

    const envelope = accept.mock.calls[0]?.[0];
    expect(envelope).toMatchObject({
      eventId: "event-1",
      type: "github.issues.opened",
      version: 1,
      businessId: "biz",
      source: { provider: "github", deliveryId: "delivery-1" },
      principal: { kind: "service", internalId: "webhook-ingress" },
      classification: ["internal"],
      data: { action: "opened" },
      rawArtifactId: "artifact-1",
      verification: { status: "verified", method: "hmac_sha256" },
    });
    expect(envelope?.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a replayed delivery as a duplicate without persisting a second event", async () => {
    const accept = vi.fn<WebhookEventSink["accept"]>(async () => ({ outcome: "duplicate" }));
    const result = await ingestWebhook(
      trigger,
      request({ action: "opened" }),
      deps({ sink: { accept } })
    );

    expect(result).toMatchObject({ status: 202, outcome: "duplicate" });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("never reports acceptance when persistence fails", async () => {
    const accept = vi.fn(async () => {
      throw new Error("inbox unavailable");
    });

    await expect(
      ingestWebhook(trigger, request({ action: "opened" }), deps({ sink: { accept } }))
    ).rejects.toThrow("inbox unavailable");
  });
});

describe("ingestWebhook — verification", () => {
  it("rejects a forged signature and persists nothing", async () => {
    const accept = vi.fn();
    const store = vi.fn();
    const result = await ingestWebhook(
      trigger,
      request({ action: "opened" }, { "x-provider-signature": sign(Buffer.from("{}")) }),
      deps({ sink: { accept }, vault: { store } })
    );

    expect(result).toEqual({ status: 401, code: "signature_invalid" });
    expect(accept).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects an unsigned delivery", async () => {
    const unsigned = request({ action: "opened" });
    const headers = { ...unsigned.headers, "x-provider-signature": undefined };

    expect(await ingestWebhook(trigger, { ...unsigned, headers }, deps())).toEqual({
      status: 401,
      code: "signature_missing",
    });
  });

  it("rejects a replayed delivery whose timestamp is outside the tolerance", async () => {
    const timestamped: WebhookTrigger = {
      ...trigger,
      verification: {
        ...trigger.verification,
        signingTemplate: "v0:{timestamp}:{body}",
        timestampHeader: "x-provider-timestamp",
        toleranceMs: 300_000,
      },
    };
    const body = Buffer.from(JSON.stringify({ action: "opened" }));
    const stale = String(Date.parse("2026-07-25T09:00:00Z") / 1000);
    const signature = createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(`v0:${stale}:`), body]))
      .digest("hex");
    const accept = vi.fn();

    const result = await ingestWebhook(
      timestamped,
      {
        rawBody: body,
        headers: {
          "x-provider-signature": signature,
          "x-provider-timestamp": stale,
          "x-provider-delivery": "delivery-1",
        },
        receivedAt: RECEIVED_AT,
      },
      deps({ sink: { accept } })
    );

    expect(result).toEqual({ status: 401, code: "timestamp_stale" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("verifies an hmac_sha1 provider against its own digest", async () => {
    const sha1: WebhookTrigger = {
      ...trigger,
      verification: { ...trigger.verification, method: "hmac_sha1" },
    };
    const body = Buffer.from(JSON.stringify({ action: "opened" }));

    const result = await ingestWebhook(
      sha1,
      {
        rawBody: body,
        headers: {
          "x-provider-signature": sign(body, "sha1"),
          "x-provider-delivery": "delivery-1",
        },
        receivedAt: RECEIVED_AT,
      },
      deps()
    );

    expect(result).toMatchObject({ status: 202, outcome: "accepted" });
  });

  it("verifies an ed25519 provider against its published public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const body = Buffer.from(JSON.stringify({ action: "opened" }));
    const detached = cryptoSign(null, body, privateKey).toString("hex");

    const ed25519: WebhookTrigger = {
      ...trigger,
      verification: { ...trigger.verification, method: "ed25519" },
    };
    const result = await ingestWebhook(
      ed25519,
      {
        rawBody: body,
        headers: {
          "x-provider-signature": detached,
          "x-provider-delivery": "delivery-1",
        },
        receivedAt: RECEIVED_AT,
      },
      deps({ secrets: { resolve: async () => raw } })
    );

    expect(result).toMatchObject({ status: 202, outcome: "accepted" });
  });

  it("fails closed, without leaking the secret, when the secret cannot be resolved", async () => {
    const result = await ingestWebhook(
      trigger,
      request({ action: "opened" }),
      deps({
        secrets: {
          resolve: async () => {
            throw new Error(`vault down for ${SECRET}`);
          },
        },
      })
    );

    expect(result).toEqual({ status: 401, code: "secret_unavailable" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("ingestWebhook — body handling", () => {
  it("refuses an oversize body before spending work on verification", async () => {
    const resolve = vi.fn(async () => SECRET);
    const big = Buffer.alloc(2048, 0x61);

    const result = await ingestWebhook(
      { ...trigger, maxBodyBytes: 1024 },
      { rawBody: big, headers: {}, receivedAt: RECEIVED_AT },
      deps({ secrets: { resolve } })
    );

    expect(result).toEqual({ status: 413, code: "body_too_large" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a JSON object", async () => {
    const body = Buffer.from("not json");
    const result = await ingestWebhook(
      trigger,
      {
        rawBody: body,
        headers: { "x-provider-signature": sign(body), "x-provider-delivery": "delivery-1" },
        receivedAt: RECEIVED_AT,
      },
      deps()
    );

    expect(result).toEqual({ status: 400, code: "payload_not_json" });
  });

  it("acknowledges a filtered delivery without persisting it", async () => {
    const accept = vi.fn();
    const store = vi.fn();
    const filtered: WebhookTrigger = {
      ...trigger,
      filter: { path: "action", equals: "closed" },
    };

    const result = await ingestWebhook(
      filtered,
      request({ action: "opened" }),
      deps({ sink: { accept }, vault: { store } })
    );

    expect(result).toEqual({
      status: 202,
      outcome: "ignored",
      eventId: null,
      deduplicationKey: null,
    });
    expect(accept).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("falls back to the payload hash when the provider sends no delivery id", async () => {
    const accept = vi.fn<WebhookEventSink["accept"]>(async () => ({ outcome: "accepted" }));
    const body = Buffer.from(JSON.stringify({ action: "opened" }));

    await ingestWebhook(
      trigger,
      {
        rawBody: body,
        headers: { "x-provider-signature": sign(body) },
        receivedAt: RECEIVED_AT,
      },
      deps({ sink: { accept } })
    );

    const envelope = accept.mock.calls[0]?.[0];
    expect(envelope?.deduplicationKey).toBe(`github-issues:${envelope?.rawPayloadHash}`);
  });
});
