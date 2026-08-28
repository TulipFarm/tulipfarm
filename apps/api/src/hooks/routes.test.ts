import { createHmac } from "node:crypto";
import type {
  RawPayloadVault,
  RegisteredTrigger,
  WebhookEventSink,
  WebhookTrigger,
} from "@tulipfarm/run-kernel";
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

  it("sheds a flood before it reaches signature verification", async () => {
    const keys: string[] = [];
    await build({
      rateLimiter: {
        async check(key, limit) {
          keys.push(key);
          return { allowed: false, limit, remaining: 0, resetAt: Date.now() + 60_000 };
        },
      },
    });

    const response = await post(JSON.stringify({ action: "opened" }));

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "rate_limit_exceeded" });
    // Per sender and per Trigger: one noisy sender cannot deny another provider's deliveries.
    expect(keys).toEqual(["rl:hook:127.0.0.1:github:issues-opened"]);
    expect(resolveTrigger).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  describe("binding the persisted event to its Routine", () => {
    const registered: RegisteredTrigger = {
      triggerSlug: "issues-opened",
      authoredVersion: 3,
      lifecycle: "published",
      type: "webhook",
      eventType: "github.issues.opened",
      eventVersion: 1,
      routineRef: { name: "triage-issue", version: "1.0.0" },
      backgroundIdentity: { principalKind: "service", principalId: "webhook-ingress" },
      inputMappings: { issueNumber: "issue.number" },
    };

    function bindable(overrides: Partial<HookIngressDeps> = {}) {
      const startRun = vi.fn<NonNullable<HookIngressDeps["startRun"]>>(async () => ({
        runId: "run-1",
        outcome: "started" as const,
      }));
      return {
        startRun,
        deps: {
          resolveInvocationTrigger: async () => registered,
          startRun,
          ...overrides,
        } satisfies Partial<HookIngressDeps>,
      };
    }

    it("starts the Routine Run a verified delivery was received for", async () => {
      const { startRun, deps } = bindable();
      await build(deps);

      const response = await post(JSON.stringify({ issue: { number: 42 } }));

      expect(response.statusCode).toBe(202);
      expect(startRun).toHaveBeenCalledTimes(1);
      const invocation = startRun.mock.calls[0]?.[0];
      expect(invocation?.routineRef).toEqual({ name: "triage-issue", version: "1.0.0" });
      // The Trigger's own declared identity, never the sender's.
      expect(invocation?.backgroundIdentity).toEqual({
        principalKind: "service",
        principalId: "webhook-ingress",
      });
      expect(invocation?.input).toEqual({ issueNumber: 42 });
      // Idempotency is the delivery's, so a redelivery adopts the Run it already made.
      expect(invocation?.idempotencyKey).toBe("issues-opened:3:issues-opened:delivery-1");
    });

    it("does not start a Run when the Trigger's filter rejects the payload", async () => {
      const { startRun, deps } = bindable({
        resolveInvocationTrigger: async () => ({
          ...registered,
          filter: "trigger.payload.issue.number > 100",
        }),
      });
      await build(deps);

      const response = await post(JSON.stringify({ issue: { number: 42 } }));

      // Still 202: the delivery was accepted and stored, it just was not what the author asked for.
      expect(response.statusCode).toBe(202);
      expect(startRun).not.toHaveBeenCalled();
    });

    it("starts a Run when the Trigger's filter accepts the payload", async () => {
      const { startRun, deps } = bindable({
        resolveInvocationTrigger: async () => ({
          ...registered,
          filter: "trigger.payload.issue.number > 100",
        }),
      });
      await build(deps);

      await post(JSON.stringify({ issue: { number: 420 } }));

      expect(startRun).toHaveBeenCalledTimes(1);
    });

    it("does not start a Run when the Trigger's match predicate rejects the payload", async () => {
      const { startRun, deps } = bindable({
        resolveInvocationTrigger: async () => ({
          ...registered,
          match: [{ path: "issue.state", equals: "open" }],
        }),
      });
      await build(deps);

      await post(JSON.stringify({ issue: { number: 42, state: "closed" } }));

      expect(startRun).not.toHaveBeenCalled();
    });

    it("re-binds a duplicate delivery, so a crash between persistence and the Run heals", async () => {
      const { startRun, deps } = bindable();
      await build(deps);
      accept.mockResolvedValue({ outcome: "duplicate" });

      const response = await post(JSON.stringify({ issue: { number: 42 } }));

      expect(response.json()).toEqual({ status: "duplicate" });
      expect(startRun).toHaveBeenCalledTimes(1);
    });

    it("still persists the event when an unresolvable mapping refuses the binding", async () => {
      const { startRun, deps } = bindable();
      await build(deps);

      const response = await post(JSON.stringify({ issue: {} }));

      // The event is real and stored; only the authored mapping is wrong, and redelivering it
      // would never bind any better.
      expect(response.statusCode).toBe(202);
      expect(accept).toHaveBeenCalledTimes(1);
      expect(startRun).not.toHaveBeenCalled();
    });

    it("fails the delivery when the Run cannot be started, so the sender retries", async () => {
      const { deps } = bindable({
        startRun: async () => {
          throw new Error("invocation gateway unavailable");
        },
      });
      await build(deps);

      const response = await post(JSON.stringify({ issue: { number: 42 } }));

      expect(response.statusCode).toBe(500);
    });

    it("does not bind an ignored delivery", async () => {
      const { startRun, deps } = bindable();
      resolveTrigger = vi.fn();
      await build(deps);
      resolveTrigger.mockResolvedValue({
        ...trigger,
        filter: { path: "action", equals: "opened" },
      });

      const response = await post(JSON.stringify({ action: "closed" }));

      expect(response.json()).toEqual({ status: "ignored" });
      expect(startRun).not.toHaveBeenCalled();
    });
  });
});
