import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type NativeWebhookRequest, nativeAutomationTarget, verifyNativeWebhook } from "./native";

const secret = "test-native-signing-secret";
const now = new Date("2026-09-18T09:00:00Z");

function slack(payload: unknown): NativeWebhookRequest {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = String(now.getTime() / 1000);
  return {
    provider: "slack",
    secret,
    rawBody,
    now,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", secret)
        .update(`v0:${timestamp}:`)
        .update(rawBody)
        .digest("hex")}`,
    },
  };
}

describe("native webhook verification", () => {
  it("answers only signed Slack challenges", () => {
    const request = slack({ type: "url_verification", challenge: "challenge" });
    expect(verifyNativeWebhook(request).challenge).toBe("challenge");
    expect(() => verifyNativeWebhook({ ...request, secret: "" })).toThrow(
      "verification_unavailable"
    );
    expect(() =>
      verifyNativeWebhook({ ...request, rawBody: Buffer.from('{"challenge":"changed"}') })
    ).toThrow("signature_invalid");
  });

  describe("native automated event targets", () => {
    it("does not turn a human comment into a Routine when the unsigned event header is replaced", () => {
      const payload = {
        action: "created",
        repository: { full_name: "business/project" },
        issue: { number: 12 },
        comment: { body: "@operations[bot] please help" },
      };
      expect(nativeAutomationTarget("github", "issue_comment", payload)).toBeUndefined();
      expect(nativeAutomationTarget("github", "issues", payload)).toBeUndefined();
      expect(nativeAutomationTarget("github", "push", payload)).toBeUndefined();
    });

    it("extracts only exact repository and channel targets from supported event shapes", () => {
      expect(
        nativeAutomationTarget("github", "push", {
          repository: { full_name: "business/project" },
          ref: "refs/heads/main",
          after: "commit",
          commits: [],
        })
      ).toEqual({ destination: "business/project", eventType: "github.push" });
      expect(
        nativeAutomationTarget("slack", "event_callback", {
          event: {
            type: "reaction_added",
            reaction: "white_check_mark",
            item: { channel: "C123" },
          },
        })
      ).toEqual({ destination: "C123", eventType: "slack.reaction_added" });
      expect(
        nativeAutomationTarget("slack", "event_callback", {
          event: { type: "message", text: "run the Routine", channel: "C123" },
        })
      ).toBeUndefined();
    });
  });

  it("refuses stale Slack signatures and duplicate signature headers", () => {
    const request = slack({ type: "url_verification", challenge: "challenge" });
    expect(() =>
      verifyNativeWebhook({ ...request, now: new Date(now.getTime() + 301_000) })
    ).toThrow("timestamp_invalid");
    expect(() =>
      verifyNativeWebhook({
        ...request,
        headers: { ...request.headers, "X-Slack-Signature": request.headers["x-slack-signature"] },
      })
    ).toThrow("signature_invalid");
  });

  it("requires exact Slack app, tenant and event identifiers", () => {
    const payload = { type: "event_callback", api_app_id: "A1", team_id: "T1", event_id: "E1" };
    expect(verifyNativeWebhook(slack(payload)).deliveryId).toBe("E1");
    expect(() => verifyNativeWebhook(slack({ ...payload, team_id: undefined }))).toThrow(
      "payload_invalid"
    );
    expect(() => verifyNativeWebhook(slack({ ...payload, event_id: undefined }))).toThrow(
      "delivery_id_missing"
    );
  });

  it("verifies raw GitHub bytes and requires the replay key", () => {
    const rawBody = Buffer.from('{"installation":{"id":1}}');
    const request: NativeWebhookRequest = {
      provider: "github",
      rawBody,
      secret,
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
      },
    };
    expect(verifyNativeWebhook(request)).toMatchObject({
      deliveryId: "delivery-1",
      eventType: "issues",
    });
    expect(() =>
      verifyNativeWebhook({
        ...request,
        headers: { ...request.headers, "x-github-delivery": undefined },
      })
    ).toThrow("delivery_id_missing");
    expect(() => verifyNativeWebhook({ ...request, rawBody: Buffer.from("{}") })).toThrow(
      "signature_invalid"
    );
  });
});
