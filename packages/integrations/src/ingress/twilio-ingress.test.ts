import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOimManifest } from "@tulipfarm/schema";
import type { RecordedDelivery, WebhookDeliveryInput } from "@tulipfarm/storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type ReceiveDeliveryDeps, receiveDelivery } from "./inbox";

const ROOT = join(__dirname, "..", "..", "..", "..", "integrations");
const CALLBACK_URL = "https://api.tulipfarm.example/api/v1/hooks/oim/twilio";
const AUTH_TOKEN = "12345";

let manifest: ReturnType<typeof parseOimManifest>;
type InboxRecord = ReceiveDeliveryDeps["inbox"]["record"];

beforeAll(async () => {
  manifest = parseOimManifest(await readFile(join(ROOT, "twilio", "oim.yml"), "utf8"));
});

function recordedDelivery(businessId: string, input: WebhookDeliveryInput): RecordedDelivery {
  const receivedAt = new Date(0);
  return {
    accepted: true,
    delivery: {
      businessId,
      ...input,
      replayOfId: input.replayOfId ?? null,
      state: "accepted",
      attempts: 0,
      lastError: null,
      normalizedPayload: null,
      receivedAt,
      nextAttemptAt: receivedAt,
      leaseExpiresAt: null,
      rawDeletedAt: null,
    },
  };
}

function dependencies(record: InboxRecord): ReceiveDeliveryDeps {
  return {
    binding: async () => ({
      connectionId: "connection-1",
      secretRef: "secret://twilio-auth-token",
    }),
    readSecret: async () => AUTH_TOKEN,
    encryptPayload: async (raw) => `enc:${raw.toString("base64")}`,
    inbox: { record },
    newDeliveryId: () => "delivery-1",
  };
}

describe("Twilio manifest ingress", () => {
  it("accepts a signed incoming message as a durable event", async () => {
    const rawBody = Buffer.from(
      [
        "MessageSid=SM11111111111111111111111111111111",
        "SmsMessageSid=SM11111111111111111111111111111111",
        "AccountSid=AC00000000000000000000000000000000",
        "From=%2B14017122661",
        "To=%2B15558675310",
        "Body=Launch+ready",
        "NumMedia=0",
        "NumSegments=1",
      ].join("&")
    );
    const record = vi.fn<InboxRecord>(async (businessId, input) =>
      recordedDelivery(businessId, input)
    );

    const result = await receiveDelivery(
      {
        businessId: "business-1",
        manifest,
        rawBody,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "joCOgAW9ilRI6SMyrGr98kctyQM=",
        },
        callbackUrl: CALLBACK_URL,
      },
      dependencies(record)
    );

    expect(result).toEqual({ kind: "accepted", deliveryId: "delivery-1", duplicate: false });
    expect(record.mock.calls[0]?.[1]).toMatchObject({
      eventType: "message.received",
      verification: "twilio_hmac_sha1",
    });
  });

  it("accepts a signed outbound message status callback", async () => {
    const rawBody = Buffer.from(
      [
        "AccountSid=AC00000000000000000000000000000000",
        "MessageSid=SM22222222222222222222222222222222",
        "MessageStatus=delivered",
        "ErrorCode=",
      ].join("&")
    );
    const record = vi.fn<InboxRecord>(async (businessId, input) =>
      recordedDelivery(businessId, input)
    );

    const result = await receiveDelivery(
      {
        businessId: "business-1",
        manifest,
        rawBody,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "EvXDmhpgNy3UoLcnWS4CUzMQCo8=",
        },
        callbackUrl: CALLBACK_URL,
      },
      dependencies(record)
    );

    expect(result).toEqual({ kind: "accepted", deliveryId: "delivery-1", duplicate: false });
    expect(record.mock.calls[0]?.[1]).toMatchObject({
      eventType: "message.status_changed",
      verification: "twilio_hmac_sha1",
    });
  });
});
