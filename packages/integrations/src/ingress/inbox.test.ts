import { createHmac } from "node:crypto";
import type { OimManifest } from "@tulipfarm/schema";
import type { RecordedDelivery, WebhookDeliveryInput } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ReceiveDeliveryDeps, receiveDelivery } from "./inbox";

const SECRET = "s3cr3t-signing-key";

const MANIFEST = {
  metadata: { id: "weather", version: "1.2.0" },
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

function signed(body: unknown, headers: Record<string, string> = {}) {
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  return { rawBody, headers: { "x-signature": signature, ...headers } };
}

function deps(overrides: Partial<ReceiveDeliveryDeps> = {}): ReceiveDeliveryDeps {
  const recorded: WebhookDeliveryInput[] = [];
  return {
    binding: async () => ({ connectionId: "connection-1", secretRef: "secret://sec-1" }),
    readSecret: async () => SECRET,
    encryptPayload: async (raw: Buffer) => `enc:${raw.toString("base64")}`,
    inbox: {
      record: async (_businessId: string, input: WebhookDeliveryInput) => {
        recorded.push(input);
        return {
          accepted: true,
          delivery: { ...input, state: "accepted" },
        } as unknown as RecordedDelivery;
      },
    },
    newDeliveryId: () => "delivery-1",
    ...overrides,
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  const { rawBody, headers: signedHeaders } = signed(body, headers);
  return { businessId: "business-1", manifest: MANIFEST, rawBody, headers: signedHeaders };
}

describe("receiveDelivery", () => {
  let record: ReturnType<typeof vi.fn>;
  let dependencies: ReceiveDeliveryDeps;

  beforeEach(() => {
    record = vi.fn(async (_businessId: string, input: WebhookDeliveryInput) => ({
      accepted: true,
      delivery: { ...input, state: "accepted" },
    }));
    dependencies = deps({ inbox: { record } as unknown as ReceiveDeliveryDeps["inbox"] });
  });

  it("persists a verified delivery before the provider can be acknowledged", async () => {
    const result = await receiveDelivery(
      request({ type: "forecast_updated" }, { "x-delivery-id": "d-9" }),
      dependencies
    );

    expect(result).toEqual({ kind: "accepted", deliveryId: "delivery-1", duplicate: false });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[1]).toMatchObject({
      integrationId: "weather",
      integrationMajorVersion: 1,
      connectionId: "connection-1",
      deduplicationKey: "d-9",
      eventType: "forecast.updated",
      verification: "hmac_sha256",
      safeHeaders: { "x-delivery-id": "d-9" },
    });
  });

  it("never persists a raw payload", async () => {
    await receiveDelivery(request({ type: "forecast_updated" }), dependencies);
    const stored = record.mock.calls[0]?.[1] as WebhookDeliveryInput;
    expect(stored.encryptedBody.startsWith("enc:")).toBe(true);
    expect(JSON.stringify(stored.safeHeaders)).not.toContain("x-signature");
  });

  it("refuses a delivery whose signature does not match", async () => {
    const req = request({ type: "forecast_updated" });
    const result = await receiveDelivery(
      { ...req, headers: { ...req.headers, "x-signature": "00" } },
      dependencies
    );

    expect(result).toMatchObject({ kind: "unverified" });
    expect(record).not.toHaveBeenCalled();
  });

  it("reads no Secret and writes no row for a handshake", async () => {
    // A handshake arrives before anything is connected; needing a Connection to answer one would
    // make the endpoint impossible to register with the provider in the first place.
    const readSecret = vi.fn(async () => SECRET);
    const manifest = {
      ...MANIFEST,
      events: {
        ...MANIFEST.events,
        handshake: { kind: "echo_body_pointer", bodyPointer: "/challenge", responseField: "token" },
      },
    } as unknown as OimManifest;

    const result = await receiveDelivery(
      { ...request({ challenge: "abc" }), manifest },
      deps({ readSecret, inbox: { record } as unknown as ReceiveDeliveryDeps["inbox"] })
    );

    expect(result).toEqual({ kind: "handshake", body: { token: "abc" } });
    expect(readSecret).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("reports a duplicate without writing a second row", async () => {
    const duplicate = vi.fn(async (_businessId: string, input: WebhookDeliveryInput) => ({
      accepted: false,
      delivery: { ...input, id: "delivery-original", state: "accepted" },
    }));
    const result = await receiveDelivery(
      request({ type: "forecast_updated" }),
      deps({ inbox: { record: duplicate } as unknown as ReceiveDeliveryDeps["inbox"] })
    );

    expect(result).toEqual({ kind: "accepted", deliveryId: "delivery-original", duplicate: true });
  });

  it("discards unrelated provider traffic after verifying it", async () => {
    const result = await receiveDelivery(request({ type: "something_else" }), dependencies);
    expect(result).toEqual({ kind: "discarded", reason: "unknown_event_type" });
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses an unparseable payload before it can be verified or stored", async () => {
    const result = await receiveDelivery(
      { businessId: "business-1", manifest: MANIFEST, rawBody: Buffer.from("nope"), headers: {} },
      dependencies
    );
    expect(result).toEqual({ kind: "unverified", reason: "unparseable_payload" });
  });

  it("says nothing useful when the Integration declares no events", async () => {
    const manifest = { ...MANIFEST, events: undefined } as unknown as OimManifest;
    const result = await receiveDelivery({ ...request({}), manifest }, dependencies);
    expect(result).toEqual({ kind: "unavailable", reason: "no_events_declared" });
  });

  it("stores nothing when nothing is connected", async () => {
    const result = await receiveDelivery(
      request({ type: "forecast_updated" }),
      deps({
        binding: async () => null,
        inbox: { record } as unknown as ReceiveDeliveryDeps["inbox"],
      })
    );
    expect(result).toEqual({ kind: "unavailable", reason: "not_connected" });
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses rather than accepting unverified bytes when the Secret is gone", async () => {
    // Accepting here would make revoking a signing Secret open the endpoint instead of closing it.
    const result = await receiveDelivery(
      request({ type: "forecast_updated" }),
      deps({
        readSecret: async () => undefined,
        inbox: { record } as unknown as ReceiveDeliveryDeps["inbox"],
      })
    );
    expect(result).toEqual({ kind: "unavailable", reason: "secret_unavailable" });
    expect(record).not.toHaveBeenCalled();
  });

  it("falls back to the exact bytes when the provider sent no delivery id", async () => {
    await receiveDelivery(request({ type: "forecast_updated" }), dependencies);
    const stored = record.mock.calls[0]?.[1] as WebhookDeliveryInput;
    expect(stored.deduplicationKey).toBe(stored.bodySha256);
  });
});
