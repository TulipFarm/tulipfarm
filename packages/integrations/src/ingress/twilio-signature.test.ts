import type { OimVerification } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { verifyDelivery } from "./verify";

const AUTH_TOKEN = "12345";
const CALLBACK_URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const VERIFICATION = {
  scheme: "twilio_hmac_sha1",
  secretSlot: "webhook_auth_token",
  signatureHeader: "X-Twilio-Signature",
  signatureEncoding: "base64",
} satisfies OimVerification;

function request(rawBody: string, signature: string) {
  return {
    rawBody: Buffer.from(rawBody, "utf8"),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    callbackUrl: CALLBACK_URL,
  };
}

describe("Twilio webhook signatures", () => {
  it("accepts Twilio's official form signature vector", () => {
    const rawBody = [
      "CallSid=CA1234567890ABCDE",
      "Digits=1234",
      "From=%2B14158675309",
      "To=%2B18005551212",
      "Caller=%2B14158675309",
    ].join("&");

    expect(
      verifyDelivery(VERIFICATION, request(rawBody, "RSOYDt4T1cUTdK1PDd93/VVr8B8="), AUTH_TOKEN)
    ).toEqual({ ok: true });
  });

  it("refuses a form field changed after signing", () => {
    const rawBody = [
      "CallSid=CA1234567890ABCDE",
      "Digits=9999",
      "From=%2B14158675309",
      "To=%2B18005551212",
      "Caller=%2B14158675309",
    ].join("&");

    expect(
      verifyDelivery(VERIFICATION, request(rawBody, "RSOYDt4T1cUTdK1PDd93/VVr8B8="), AUTH_TOKEN)
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses malformed form encoding", () => {
    expect(
      verifyDelivery(
        VERIFICATION,
        request("MessageSid=SM123&Body=%E0%A4%A", "RSOYDt4T1cUTdK1PDd93/VVr8B8="),
        AUTH_TOKEN
      )
    ).toEqual({ ok: false, reason: "malformed_payload" });
  });

  it("refuses a malformed signature", () => {
    expect(
      verifyDelivery(VERIFICATION, request("MessageSid=SM123", "not-base64"), AUTH_TOKEN)
    ).toEqual({ ok: false, reason: "malformed_signature" });
    expect(verifyDelivery(VERIFICATION, request("MessageSid=SM123", "AAAA"), AUTH_TOKEN)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });

  it("requires Twilio's documented signature header", () => {
    const alternateHeader: OimVerification = {
      ...VERIFICATION,
      signatureHeader: "x-attacker-signature",
    };
    expect(
      verifyDelivery(
        alternateHeader,
        {
          rawBody: Buffer.from("MessageSid=SM123"),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-attacker-signature": "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
          },
          callbackUrl: CALLBACK_URL,
        },
        AUTH_TOKEN
      )
    ).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("matches Twilio's official duplicate-parameter vector", () => {
    const rawBody = "Sid=CA123&SidAccount=AC123&Digits=5678&Digits=1234&Digits=1234";

    expect(
      verifyDelivery(VERIFICATION, request(rawBody, "IK+Dwps556ElfBT0I3Rgjkr1wJU="), AUTH_TOKEN)
    ).toEqual({ ok: true });
  });

  it("does not infer the signed URL from request headers", () => {
    const rawBody = "MessageSid=SM123";
    expect(
      verifyDelivery(
        VERIFICATION,
        {
          rawBody: Buffer.from(rawBody),
          headers: {
            host: "attacker.example",
            "x-forwarded-host": "attacker.example",
            "x-twilio-signature": "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
          },
        },
        AUTH_TOKEN
      )
    ).toEqual({ ok: false, reason: "missing_callback_url" });
  });
});
