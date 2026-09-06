import type { PersistedWebhookDelivery } from "@tulipfarm/storage";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "../identity/principal";
import { type DeliveryInboxReader, registerDeliveryRoutes } from "./delivery-routes";

const ADMIN: RequestPrincipal = {
  kind: "user",
  id: "user-1",
  businessId: "biz-1",
  role: "admin",
} as RequestPrincipal;

function delivery(overrides: Partial<PersistedWebhookDelivery> = {}): PersistedWebhookDelivery {
  return {
    businessId: "biz-1",
    id: "d-1",
    integrationId: "weather",
    integrationMajorVersion: 1,
    connectionId: "connection-1",
    deduplicationKey: "k-1",
    bodySha256: "a".repeat(64),
    safeHeaders: { "x-delivery-id": "d-1" },
    encryptedBody: "enc:payload",
    eventType: "forecast.updated",
    verification: "hmac_sha256",
    state: "dead_letter",
    attempts: 5,
    lastError: "boom",
    normalizedPayload: null,
    replayOfId: null,
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    nextAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
    leaseExpiresAt: null,
    rawDeletedAt: null,
    ...overrides,
  };
}

let app: FastifyInstance;
let inbox: DeliveryInboxReader;
let listDeadLettered: ReturnType<typeof vi.fn>;
let findById: ReturnType<typeof vi.fn>;
let replay: ReturnType<typeof vi.fn>;
let authorize: ReturnType<typeof vi.fn>;
let audit: ReturnType<typeof vi.fn>;
let principal: RequestPrincipal | undefined;

beforeEach(async () => {
  principal = ADMIN;
  listDeadLettered = vi.fn(async () => [delivery()]);
  findById = vi.fn(async () => delivery());
  replay = vi.fn(async (_businessId: string, id: string, newId: string) =>
    delivery({ id: newId, replayOfId: id, state: "accepted", attempts: 0, lastError: null })
  );
  authorize = vi.fn(async () => true);
  audit = vi.fn(async () => undefined);
  inbox = { listDeadLettered, findById, replay } as unknown as DeliveryInboxReader;

  await build();
});

async function build() {
  await app?.close();
  app = Fastify();
  registerDeliveryRoutes(app, {
    inbox,
    requireAuth: async (req: FastifyRequest) => {
      (req as FastifyRequest & { principal?: RequestPrincipal }).principal = principal;
    },
    authorizationCheck: authorize as never,
    newDeliveryId: () => "d-replay",
    audit: audit as never,
  });
  await app.ready();
}

function withInbox(
  overrides: Partial<Record<"listDeadLettered" | "findById" | "replay", unknown>>
) {
  inbox = { listDeadLettered, findById, replay, ...overrides } as unknown as DeliveryInboxReader;
}

afterEach(async () => {
  await app?.close();
});

describe("GET /api/v1/integrations/deliveries/dead-letter", () => {
  it("lists what failed for the caller's own business", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/deliveries/dead-letter",
    });

    expect(response.statusCode).toBe(200);
    expect(listDeadLettered).toHaveBeenCalledWith("biz-1", 50);
    expect(response.json().deliveries[0]).toMatchObject({
      id: "d-1",
      state: "dead_letter",
      lastError: "boom",
      replayable: true,
    });
  });

  it("never returns the payload", async () => {
    // This endpoint answers "what broke". A provider payload is business data, and a listing is
    // not the place to widen who can read it.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/deliveries/dead-letter",
    });
    expect(JSON.stringify(response.json())).not.toContain("enc:payload");
  });

  it("marks a delivery whose payload retention expired as no longer replayable", async () => {
    listDeadLettered = vi.fn(async () => [delivery({ encryptedBody: null })]);
    withInbox({ listDeadLettered });
    await build();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/deliveries/dead-letter",
    });
    expect(response.json().deliveries[0].replayable).toBe(false);
  });

  it("refuses a caller the gate declines", async () => {
    authorize = vi.fn(async () => false);
    await build();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/deliveries/dead-letter",
    });
    expect(response.statusCode).toBe(403);
    expect(listDeadLettered).not.toHaveBeenCalled();
  });

  it("refuses a request with no principal", async () => {
    principal = undefined;
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/deliveries/dead-letter",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /api/v1/integrations/deliveries/:id/replay", () => {
  it("creates a new delivery that names the original", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/deliveries/d-1/replay",
    });

    expect(response.statusCode).toBe(201);
    expect(replay).toHaveBeenCalledWith("biz-1", "d-1", "d-replay");
    expect(response.json()).toMatchObject({ id: "d-replay", replayOfId: "d-1", attempts: 0 });
  });

  it("records who replayed what", async () => {
    await app.inject({ method: "POST", url: "/api/v1/integrations/deliveries/d-1/replay" });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      "integration.delivery.replay",
      "delivery:d-replay",
      expect.objectContaining({ replayOf: "d-1", integrationId: "weather" })
    );
  });

  it("checks authority before touching the inbox", async () => {
    // A replay causes provider effects. Discovering that a delivery exists must not precede
    // deciding whether this caller may act on it.
    authorize = vi.fn(async () => false);
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/deliveries/d-1/replay",
    });
    expect(response.statusCode).toBe(403);
    expect(findById).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it("asks for the replay action rather than the read one", async () => {
    await app.inject({ method: "POST", url: "/api/v1/integrations/deliveries/d-1/replay" });
    expect(authorize).toHaveBeenCalledWith(
      ADMIN,
      expect.objectContaining({
        action: "integration.delivery.replay",
        resourceType: "integration.delivery",
      })
    );
  });

  it("explains why an expired delivery cannot be replayed", async () => {
    findById = vi.fn(async () => delivery({ encryptedBody: null, rawDeletedAt: new Date() }));
    withInbox({ findById });
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/deliveries/d-1/replay",
    });
    expect(response.statusCode).toBe(409);
    expect(replay).not.toHaveBeenCalled();
  });

  it("does not reach another business's delivery", async () => {
    findById = vi.fn(async () => null);
    withInbox({ findById });
    await build();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/deliveries/d-1/replay",
    });
    expect(response.statusCode).toBe(404);
  });
});
