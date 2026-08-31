import type { BundledIntegration, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import type { IngressJobPayload } from "./routes";
import { computeHmacSignature } from "./signature";

const SECRET = "test-signing-secret";

/** Synthetic provider: timestamped HMAC, a ping handshake, delivery-kind accept filter. */
const SECURITY = {
  type: "hmac_sha256" as const,
  header: "X-Provider-Signature",
  secret_env: "PROVIDER_SIGNING_SECRET",
  signing: "v0:{timestamp}:{body}",
  format: "v0={hex}",
  timestamp_header: "X-Provider-Timestamp",
  tolerance_seconds: 300,
};

function makeIntegration(overrides: Partial<SoulIntegration> = {}): SoulIntegration {
  return {
    slug: "chatapp",
    sourceIntegration: "chatapp",
    manifest: {
      name: "chatapp",
      egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } },
      ingress: {
        handler: "ingress.ts",
        webhook: {
          security: SECURITY,
          handshake: {
            match: { path: "kind", equals: "ping" },
            respond: { echo: "{nonce}", ok: "yes" },
          },
          accept: { path: "kind", equals: "delivery" },
          dedup_key: "delivery_id",
        },
      },
    },
    connection: { enabled: true, env: { PROVIDER_SIGNING_SECRET: SECRET } },
    ingressHandler: { source: "export function classify() {}", hash: "abc" },
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

  async function build(
    integrations: SoulIntegration[] = [makeIntegration()],
    resolveSecret?: (value: string) => Promise<string | undefined>,
    bundled: ReadonlyMap<string, BundledIntegration> = new Map()
  ) {
    enqueue = vi.fn(async (_job: IngressJobPayload) => {});
    seen = new Set();
    app = await buildApp({
      ingress: {
        soulLoader: makeSoulLoader(integrations),
        bundled,
        deliveries: {
          recordDelivery: async (slug: string, key: string) => {
            const composite = `${slug}:${key}`;
            if (seen.has(composite)) return false;
            seen.add(composite);
            return true;
          },
        } as never,
        invoke: enqueue as (job: IngressJobPayload) => Promise<void>,
        resolveSecret,
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
    opts: {
      sign?: boolean;
      secret?: string;
      name?: string;
      timestamp?: string;
      extraHeaders?: Record<string, string>;
    } = {}
  ): Promise<LightMyRequestResponse> {
    const { sign = true, secret = SECRET, name = "chatapp" } = opts;
    const body = JSON.stringify(payload);
    const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...opts.extraHeaders,
    };
    if (sign) {
      headers["x-provider-timestamp"] = timestamp;
      headers["x-provider-signature"] = computeHmacSignature(body, SECURITY, secret, timestamp);
    }
    return app.inject({
      method: "POST",
      url: `/api/v1/hooks/integrations/${name}`,
      headers,
      payload: body,
    });
  }

  const EVENT = {
    kind: "delivery",
    delivery_id: "D123",
    event: { type: "message", channel: "C1" },
  };

  it("answers the handshake with the templated respond body (signed)", async () => {
    const res = await inject({ kind: "ping", nonce: "n-42" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ echo: "n-42", ok: "yes" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("accepts a signed delivery and enqueues {slug, body}", async () => {
    const res = await inject(EVENT);
    expect(res.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toEqual({ slug: "chatapp", body: EVENT });
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

  it("dedups a retried delivery (same dedup key acked, enqueued once)", async () => {
    const first = await inject(EVENT);
    const retry = await inject(EVENT);
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("dedups on a declared header and forwards context headers into the job", async () => {
    await app.close();
    const integration = makeIntegration();
    const ingress = integration.manifest?.ingress;
    if (ingress) {
      ingress.webhook.dedup_key = undefined;
      ingress.webhook.dedup_header = "X-Provider-Delivery";
      ingress.webhook.context_headers = ["X-Provider-Event"];
    }
    await build([integration]);

    const extraHeaders = { "x-provider-delivery": "guid-1", "x-provider-event": "issues" };
    await inject(EVENT, { extraHeaders });
    await inject(EVENT, { extraHeaders }); // same delivery guid → deduped
    await inject(EVENT, { extraHeaders: { ...extraHeaders, "x-provider-delivery": "guid-2" } });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0][0]).toEqual({
      slug: "chatapp",
      body: EVENT,
      headers: { "x-provider-event": "issues" },
    });
  });

  it("enqueues without dedup when the manifest declares no dedup_key", async () => {
    await app.close();
    const integration = makeIntegration();
    const ingress = integration.manifest?.ingress;
    if (ingress) ingress.webhook.dedup_key = undefined;
    await build([integration]);
    await inject(EVENT);
    await inject(EVENT);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("404s for unknown integration, undeclared ingress, missing handler module, and disconnected — same body", async () => {
    const unknown = await inject(EVENT, { name: "otherapp" });
    expect(unknown.statusCode).toBe(404);

    await app.close();
    await build([
      makeIntegration({
        manifest: {
          name: "chatapp",
          egress: { type: "mcp", entry: { transport: "stdio", command: "npx" } },
        },
      } as Partial<SoulIntegration>),
    ]);
    const undeclared = await inject(EVENT);
    expect(undeclared.statusCode).toBe(404);

    await app.close();
    await build([makeIntegration({ ingressHandler: undefined })]);
    const handlerless = await inject(EVENT);
    expect(handlerless.statusCode).toBe(404);

    await app.close();
    await build([
      makeIntegration({
        connection: { enabled: false, env: { PROVIDER_SIGNING_SECRET: SECRET } },
      }),
    ]);
    const disconnected = await inject(EVENT);
    expect(disconnected.statusCode).toBe(404);

    expect(unknown.json()).toEqual(undeclared.json());
    expect(undeclared.json()).toEqual(handlerless.json());
    expect(handlerless.json()).toEqual(disconnected.json());
  });

  it("resolves a secret:// signing secret through the resolver and accepts the delivery", async () => {
    await app.close();
    await build(
      [
        makeIntegration({
          connection: {
            enabled: true,
            env: {
              PROVIDER_SIGNING_SECRET: "secret://integration.chatapp.PROVIDER_SIGNING_SECRET",
            },
          },
        }),
      ],
      async (value) =>
        value === "secret://integration.chatapp.PROVIDER_SIGNING_SECRET" ? SECRET : undefined
    );
    const res = await inject(EVENT);
    expect(res.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("401s a secret:// signing secret that cannot be resolved", async () => {
    await app.close();
    await build(
      [
        makeIntegration({
          connection: {
            enabled: true,
            env: { PROVIDER_SIGNING_SECRET: "secret://integration.chatapp.MISSING" },
          },
        }),
      ],
      async () => undefined
    );
    const res = await inject(EVENT);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "webhook secret not configured" });
  });

  it("401s when the signing secret is missing from the connection env", async () => {
    await app.close();
    await build([makeIntegration({ connection: { enabled: true, env: {} } })]);
    const res = await inject(EVENT);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "webhook secret not configured" });
  });

  it("acks payloads failing the accept filter without enqueueing", async () => {
    const res = await inject({ kind: "system_notice" });
    expect(res.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues everything when no accept filter is declared", async () => {
    await app.close();
    const integration = makeIntegration();
    const ingress = integration.manifest?.ingress;
    if (ingress) ingress.webhook.accept = undefined;
    await build([integration]);
    const res = await inject({ kind: "system_notice" });
    expect(res.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
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

describe("bundled (code-owned) integrations", () => {
  let app: FastifyInstance;
  let enqueue: ReturnType<typeof vi.fn>;

  afterEach(async () => {
    await app.close();
  });

  /**
   * A bundled integration (github, slack) writes only `connection.yaml` into Soul on install —
   * never `manifest.yml` (that stays code-owned). So `soulLoader.integrations.get(slug)` alone
   * returns `{ slug, sourceIntegration, connection }` with no `manifest` and no `ingressHandler`
   * at all, regardless of what the bundled manifest declares. Regression: the route used to read
   * only `soulLoader`, so every bundled integration's ingress 404'd unconditionally — this is
   * exactly what GitHub hit in production (195 webhooks, all 404, zero rows ever ingested).
   */
  it("resolves ingress from the bundled manifest merged with live Soul connection state", async () => {
    enqueue = vi.fn(async (_job: IngressJobPayload) => {});
    const bundledManifest: BundledIntegration = {
      manifest: {
        name: "github",
        egress: { type: "none" },
        ingress: {
          handler: "ingress.ts",
          webhook: {
            security: {
              type: "hmac_sha256",
              header: "X-Hub-Signature-256",
              secret_env: "GITHUB_WEBHOOK_SECRET",
              format: "sha256={hex}",
            },
            dedup_header: "X-GitHub-Delivery",
            context_headers: ["X-GitHub-Event"],
          },
        },
      },
      ingressHandlerFile: { file: "ingress.ts", raw: "({ classify() {} })" },
    };
    // Soul only ever carries connection state for a bundled slug — no manifest, no ingressHandler.
    const soulOnlyConnection = {
      slug: "github",
      sourceIntegration: "github",
      connection: { enabled: true, env: { GITHUB_WEBHOOK_SECRET: SECRET } },
    } as SoulIntegration;

    app = await buildApp({
      ingress: {
        soulLoader: makeSoulLoader([soulOnlyConnection]),
        bundled: new Map([["github", bundledManifest]]),
        deliveries: { recordDelivery: async () => true } as never,
        invoke: enqueue as (job: IngressJobPayload) => Promise<void>,
      },
    });

    const body = JSON.stringify({ action: "opened" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/integrations/github",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": computeHmacSignature(body, { format: "sha256={hex}" }, SECRET),
        "x-github-delivery": "d-1",
        "x-github-event": "issues",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("still 404s a bundled slug with no matching Soul connection at all", async () => {
    enqueue = vi.fn(async (_job: IngressJobPayload) => {});
    app = await buildApp({
      ingress: {
        soulLoader: makeSoulLoader([]),
        bundled: new Map(),
        deliveries: { recordDelivery: async () => true } as never,
        invoke: enqueue as (job: IngressJobPayload) => Promise<void>,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/integrations/github",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
