import type { SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { IngressJobPayload } from "./routes";
import { computeSlackSignature } from "./signature";

const SECRET = "test-signing-secret";

function makeIntegration(overrides: Partial<SoulIntegration> = {}): SoulIntegration {
  return {
    slug: "slack",
    sourceIntegration: "slack",
    manifest: {
      name: "slack",
      egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } },
      ingress: {
        type: "asyncapi",
        spec: "asyncapi.yml",
        webhook: {
          path: "/",
          security: {
            type: "hmac_sha256",
            header: "X-Slack-Signature",
            secret_env: "SLACK_SIGNING_SECRET",
          },
          verification_protocol: "slack",
        },
      },
    },
    connection: { enabled: true, env: { SLACK_SIGNING_SECRET: SECRET } },
    ...overrides,
  } as SoulIntegration;
}

function makeSoulLoader(integrations: SoulIntegration[]): SoulLoader {
  return {
    integrations: new Map(integrations.map((i) => [i.slug, i])),
  } as unknown as SoulLoader;
}

describe("POST /api/v1/hooks/integrations/:name", () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;
  let seen: Set<string>;

  async function build(integrations: SoulIntegration[] = [makeIntegration()]) {
    enqueue = vi.fn(async (_job: IngressJobPayload) => {});
    seen = new Set();
    app = await buildApp({
      ingress: {
        soulLoader: makeSoulLoader(integrations),
        deliveries: {
          recordDelivery: async (slug: string, key: string) => {
            const composite = `${slug}:${key}`;
            if (seen.has(composite)) return false;
            seen.add(composite);
            return true;
          },
        } as never,
        enqueue: enqueue as (job: IngressJobPayload) => Promise<void>,
      },
    });
  }

  beforeEach(async () => {
    await build();
  });

  afterEach(async () => {
    await app.close();
  });

  function inject(
    payload: Record<string, unknown>,
    opts: { sign?: boolean; secret?: string; name?: string; timestamp?: string } = {}
  ): Promise<LightMyRequestResponse> {
    const { sign = true, secret = SECRET, name = "slack" } = opts;
    const body = JSON.stringify(payload);
    const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sign) {
      headers["x-slack-request-timestamp"] = timestamp;
      headers["x-slack-signature"] = computeSlackSignature(body, timestamp, secret);
    }
    return app.inject({
      method: "POST",
      url: `/api/v1/hooks/integrations/${name}`,
      headers,
      payload: body,
    });
  }

  const EVENT = {
    type: "event_callback",
    event_id: "Ev123",
    team_id: "T1",
    event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "<@UBOT> hi" },
  };

  it("answers the url_verification challenge (signed)", async () => {
    const res = await inject({ type: "url_verification", challenge: "chal-123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: "chal-123" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts a signed event and enqueues it", async () => {
    const res = await inject(EVENT);
    expect(res.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ slug: "slack", protocol: "slack" });
  });

  it("rejects a bad signature and a missing signature with 401", async () => {
    const bad = await inject(EVENT, { secret: "wrong-secret" });
    expect(bad.statusCode).toBe(401);
    const missing = await inject(EVENT, { sign: false });
    expect(missing.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp with 401", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const res = await inject(EVENT, { timestamp: stale });
    expect(res.statusCode).toBe(401);
  });

  it("dedups a retried delivery (same event_id acked, enqueued once)", async () => {
    const first = await inject(EVENT);
    const retry = await inject(EVENT);
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("404s for an unknown integration, undeclared ingress, and a disconnected integration — same body", async () => {
    const unknown = await inject(EVENT, { name: "github" });
    expect(unknown.statusCode).toBe(404);

    await app.close();
    await build([
      makeIntegration({
        manifest: {
          name: "slack",
          egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } },
        },
      } as Partial<SoulIntegration>),
    ]);
    const undeclared = await inject(EVENT);
    expect(undeclared.statusCode).toBe(404);

    await app.close();
    await build([
      makeIntegration({ connection: { enabled: false, env: { SLACK_SIGNING_SECRET: SECRET } } }),
    ]);
    const disconnected = await inject(EVENT);
    expect(disconnected.statusCode).toBe(404);

    expect(unknown.json()).toEqual(undeclared.json());
    expect(undeclared.json()).toEqual(disconnected.json());
  });

  it("401s when the signing secret is missing from the connection env", async () => {
    await app.close();
    await build([makeIntegration({ connection: { enabled: true, env: {} } })]);
    const res = await inject(EVENT);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "webhook secret not configured" });
  });

  it("acks non-event_callback payloads without enqueueing", async () => {
    const res = await inject({ type: "app_rate_limited" });
    expect(res.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not disturb JSON parsing on other routes (scoped raw-body parser)", async () => {
    // A route OUTSIDE the ingress plugin scope must still get parsed JSON, not a raw Buffer.
    app.post("/echo-json", async (req) => ({
      isBuffer: Buffer.isBuffer(req.body),
      body: req.body,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/echo-json",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ a: 1 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isBuffer: false, body: { a: 1 } });
  });
});
