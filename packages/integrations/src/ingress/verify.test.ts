import { createHmac } from "node:crypto";
import type { OimVerification } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { verifyDelivery } from "./verify";

const secret = "test-hubspot-signing-secret";
const callbackUrl = "https://api.example.test/api/v1/hooks/oim/hubspot%2Fv3/connection-1";
const decodedCallbackUrl = "https://api.example.test/api/v1/hooks/oim/hubspot/v3/connection-1";
const rawBody = Buffer.from('[{"eventId":1}]');
const nowSeconds = 1_772_009_200;
const timestamp = String(nowSeconds * 1_000);

const verification: OimVerification = {
  scheme: "hubspot_v3",
  secretSlot: "webhook_secret",
  signatureHeader: "X-HubSpot-Signature-v3",
  signatureEncoding: "base64",
  timestampHeader: "X-HubSpot-Request-Timestamp",
  toleranceSeconds: 300,
};

function signature(url = decodedCallbackUrl, signedAt = timestamp): string {
  return createHmac("sha256", secret)
    .update("POST")
    .update(url)
    .update(rawBody)
    .update(signedAt)
    .digest("base64");
}

describe("HubSpot webhook signature verification", () => {
  it("accepts the v3 signature over POST, decoded callback URL, raw body, and millisecond timestamp", () => {
    expect(
      verifyDelivery(
        verification,
        {
          rawBody,
          callbackUrl,
          headers: {
            "x-hubspot-signature-v3": signature(),
            "x-hubspot-request-timestamp": timestamp,
          },
        },
        secret,
        nowSeconds
      )
    ).toMatchObject({ ok: true });
  });

  it("rejects a signature replayed against a different callback URL", () => {
    expect(
      verifyDelivery(
        verification,
        {
          rawBody,
          callbackUrl: "https://api.example.test/api/v1/hooks/oim/hubspot/v3/connection-2",
          headers: {
            "x-hubspot-signature-v3": signature(),
            "x-hubspot-request-timestamp": timestamp,
          },
        },
        secret,
        nowSeconds
      )
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects expired v3 signatures even when their digest is valid", () => {
    const staleTimestamp = String((nowSeconds - 301) * 1_000);
    expect(
      verifyDelivery(
        verification,
        {
          rawBody,
          callbackUrl,
          headers: {
            "x-hubspot-signature-v3": signature(decodedCallbackUrl, staleTimestamp),
            "x-hubspot-request-timestamp": staleTimestamp,
          },
        },
        secret,
        nowSeconds
      )
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });
});
