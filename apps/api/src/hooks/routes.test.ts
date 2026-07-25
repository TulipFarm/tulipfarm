import { createHmac } from "node:crypto";
import type { RawPayloadVault, WebhookEventSink, WebhookTrigger } from "@tulipfarm/run-kernel";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { buildApp } from "../app";
import type { HookIngressDeps } from "./routes";

const SECRET = "hook-signing-secret";

const trigger: WebhookTrigger = {
  triggerSlug: "issues-opened",
  businessId: "biz",
  provider: "github",
  eventType: "github.issues.opened",
  eventVersion: 1,
  verification: {
    method: "hmac_sha256",
    secretRef: "secret://github/webhook",
    signatureHeader: "x-hub-signature-256",
  },
  deliveryIdHeader: "x-github-delivery",
  backgroundIdentity: { principalKind: "service", principalId: "webhook-ingress" },
};

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
}

describe("POST /api/v1/hooks/:provider/:trigger", () => {
  let app: FastifyInstance;
  let accept: Mock<WebhookEventSink["accept"]>;
  let store: Mock<RawPayloadVault["store"]>;
  let resolveTrigger: Mock<HookIngressDeps["resolveTrigger"]>;

  async function build(deps: Partial<HookIngressDeps> = {}): Promise<FastifyInstance> {
    accept = vi.fn<WebhookEventSink["accept"]>(async () => ({ outcome: "accepted" }));
    store = vi.fn<RawPayloadVault["store"]>(async () => ({ artifactId: "artifact-1" }));
    resolveTrigger = vi.fn<HookIngressDeps["resolveTrigger"]>(async () => trigger);

    app = await buildApp({
      hookIngress: {
        resolveTrigger,
        ingress: {
          secrets: { resolve: async () => SECRET },
          vault: { store },
          sink: { accept },
          nextEventId: () => "event-1",
        },
        ...deps,
      },
    });
    await app.ready();
    return app;
  }

  function post(body: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/v1/hooks/github/issues-opened",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body),
        "x-github-delivery": "delivery-1",
        ...headers,
      },
      payload: body,
    });
  }

  afterEach(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await build();
  });

  it("acknowledges a signed delivery only after the canonical event is persisted", async () => {
    const response = await post(JSON.stringify({ action: "opened" }));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]?.[0]).toMatchObject({
      type: "github.issues.opened",
      verification: { status: "verified", method: "hmac_sha256" },
    });
  });

  it("reports a redelivered webhook as a duplicate", async () => {
    await build();
    accept.mockResolvedValueOnce({ outcome: "duplicate" });

    const response = await post(JSON.stringify({ action: "opened" }));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "duplicate" });
  });

  it("rejects a forged signature without persisting anything", async () => {
    const response = await post(JSON.stringify({ action: "opened" }), {
      "x-hub-signature-256": sign("{}"),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "signature_invalid" });
    expect(accept).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects an oversize body", async () => {
    await build();
    resolveTrigger.mockResolvedValue({ ...trigger, maxBodyBytes: 32 });

    const response = await post(JSON.stringify({ action: "x".repeat(64) }));

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "body_too_large" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("returns a constant 404 for an unknown Trigger, revealing nothing about it", async () => {
    await build();
    resolveTrigger.mockResolvedValue(null);

    const response = await post(JSON.stringify({ action: "opened" }));

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "hook not found" });
    expect(accept).not.toHaveBeenCalled();
  });
});
