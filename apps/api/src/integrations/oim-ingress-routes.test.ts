import { createHmac } from "node:crypto";
import type { OimManifest } from "@tulipfarm/schema";
import type { WebhookDeliveryInput } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type OimIngressRouteDeps, registerOimIngressRoutes } from "./oim-ingress-routes";

const SECRET = "s3cr3t-signing-key";

const MANIFEST = {
  metadata: { id: "weather", version: "1.0.0" },
  events: {
    path: "/weather",
    verification: {
      scheme: "hmac_sha256",
      secretSlot: "webhook_secret",
      signatureHeader: "x-signature",
      signatureEncoding: "hex",
    },
    deduplication: { kind: "delivery_id_header", header: "x-delivery-id" },
    eventTypes: [
      {
        type: "forecast.updated",
        selector: { pointer: "/type", equals: "forecast_updated" },
        schema: { type: "object" },
        safeHeaders: ["x-delivery-id"],
      },
    ],
  },
} as unknown as OimManifest;

let app: FastifyInstance;
let record: ReturnType<typeof vi.fn>;
let resolve: ReturnType<typeof vi.fn>;
let binding: ReturnType<typeof vi.fn>;

function payload(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  return {
    raw,
    signature: createHmac("sha256", secret).update(Buffer.from(raw, "utf8")).digest("hex"),
  };
}

async function build(overrides: Partial<OimIngressRouteDeps> = {}) {
  app = Fastify();
  await registerOimIngressRoutes(app, {
    resolve: resolve as unknown as OimIngressRouteDeps["resolve"],
    binding: binding as unknown as OimIngressRouteDeps["binding"],
    readSecret: async () => SECRET,
    encryptPayload: async (raw: Buffer) => `enc:${raw.toString("base64")}`,
    inbox: { record } as unknown as OimIngressRouteDeps["inbox"],
    newDeliveryId: () => "delivery-1",
    ...overrides,
  });
  await app.ready();
}

beforeEach(() => {
  record = vi.fn(async (_businessId: string, input: WebhookDeliveryInput) => ({
    accepted: true,
    delivery: { ...input, state: "accepted" },
  }));
  resolve = vi.fn(async () => ({ businessId: "biz-1", manifest: MANIFEST }));
  binding = vi.fn(async () => ({ connectionId: "connection-1", secretRef: "secret://sec-1" }));
});

afterEach(async () => {
  await app?.close();
});

async function post(body: unknown, headers: Record<string, string> = {}, secret = SECRET) {
  const { raw, signature } = payload(body, secret);
  return app.inject({
    method: "POST",
    url: "/api/v1/hooks/oim/weather",
    headers: { "content-type": "application/json", "x-signature": signature, ...headers },
    payload: raw,
  });
}

describe("POST /api/v1/hooks/oim/:slug", () => {
  it("acknowledges a verified delivery only after it is durable", async () => {
    await build();
    const response = await post({ type: "forecast_updated" }, { "x-delivery-id": "d-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(record).toHaveBeenCalledOnce();
  });

  it("delivers a Team webhook through the Connection named by its URL", async () => {
    binding.mockResolvedValue({
      connectionId: "team-connection",
      secretRef: "secret://sec-1",
    });
    await build();
    const { raw, signature } = payload({ type: "forecast_updated" });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/oim/weather?connectionId=team-connection",
      headers: { "content-type": "application/json", "x-signature": signature },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(binding).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "team-connection" })
    );
    expect(record.mock.calls[0]?.[1]).toMatchObject({ connectionId: "team-connection" });
  });

  it("verifies against the exact bytes the provider sent", async () => {
    // Re-serializing the parsed body would change key order and whitespace, and every signature
    // computed over the original bytes would fail.
    await build();
    const signature = createHmac("sha256", SECRET)
      .update(Buffer.from('{"type":"forecast_updated","b":1}', "utf8"))
      .digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hooks/oim/weather",
      headers: { "content-type": "application/json", "x-signature": signature },
      payload: '{"type":"forecast_updated","b":1}',
    });

    expect(response.statusCode).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });

  it("rejects a delivery signed with the wrong Secret", async () => {
    await build();
    const response = await post({ type: "forecast_updated" }, {}, "wrong-key");

    expect(response.statusCode).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("never leaks the reason a delivery failed", async () => {
    await build();
    const response = await post({ type: "forecast_updated" }, {}, "wrong-key");
    expect(response.json()).toEqual({ error: "invalid signature" });
  });

  it("answers a handshake with the value the provider asked us to echo", async () => {
    const manifest = {
      ...MANIFEST,
      events: {
        ...MANIFEST.events,
        handshake: { kind: "echo_body_pointer", bodyPointer: "/challenge", responseField: "token" },
      },
    } as unknown as OimManifest;
    resolve = vi.fn(async () => ({ businessId: "biz-1", manifest }));
    await build();

    const response = await post({ challenge: "abc123" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ token: "abc123" });
    expect(record).not.toHaveBeenCalled();
  });

  it("answers the same way for an Integration that is not installed", async () => {
    // A caller that could tell the two apart could map which Integrations an instance runs.
    resolve = vi.fn(async () => null);
    await build();
    const response = await post({ type: "forecast_updated" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
  });

  it("answers the same way when nothing is connected", async () => {
    await build({ binding: async () => null });
    const response = await post({ type: "forecast_updated" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(record).not.toHaveBeenCalled();
  });

  it("acknowledges but stores nothing for unrelated provider traffic", async () => {
    await build();
    const response = await post({ type: "something_else" });

    expect(response.statusCode).toBe(200);
    expect(record).not.toHaveBeenCalled();
  });

  it("acknowledges a provider retry without storing it twice", async () => {
    const duplicate = vi.fn(async (_businessId: string, input: WebhookDeliveryInput) => ({
      accepted: false,
      delivery: { ...input, id: "delivery-original", state: "accepted" },
    }));
    await build({ inbox: { record: duplicate } as unknown as OimIngressRouteDeps["inbox"] });

    expect((await post({ type: "forecast_updated" })).statusCode).toBe(200);
  });

  it("does not require a session", async () => {
    await build();
    const response = await post({ type: "forecast_updated" });
    expect(response.statusCode).not.toBe(401);
  });

  it("leaves other routes parsing JSON normally", async () => {
    app = Fastify();
    app.post("/echo", async (req) => req.body);
    await registerOimIngressRoutes(app, {
      resolve: resolve as unknown as OimIngressRouteDeps["resolve"],
      binding: async () => ({ connectionId: "connection-1", secretRef: "secret://sec-1" }),
      readSecret: async () => SECRET,
      encryptPayload: async (raw: Buffer) => `enc:${raw.toString("base64")}`,
      inbox: { record } as unknown as OimIngressRouteDeps["inbox"],
      newDeliveryId: () => "delivery-1",
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: '{"a":1}',
    });
    expect(response.json()).toEqual({ a: 1 });
  });
});
