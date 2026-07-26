import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  acceptGenericWebhook,
  type GenericWebhookDependencies,
  GenericWebhookError,
  type GenericWebhookRequest,
} from "./webhook";

const RAW_BODY = JSON.stringify({ event: { type: "invoice.paid" }, amount: 42 });
const NOW_SECONDS = 1_785_004_800;

function signedRequest(overrides: Partial<GenericWebhookRequest> = {}): GenericWebhookRequest {
  const timestamp = String(NOW_SECONDS);
  const signature = createHmac("sha256", "webhook-secret")
    .update(`${timestamp}.${RAW_BODY}`)
    .digest("hex");
  return {
    rawBody: RAW_BODY,
    headers: {
      "x-delivery-id": "delivery-1",
      "x-signature": `sha256=${signature}`,
      "x-timestamp": timestamp,
    },
    ...overrides,
  };
}

function dependencies(): GenericWebhookDependencies {
  return {
    secrets: {
      use: async (_secretRef, callback) => callback("webhook-secret"),
    },
    inbox: {
      accept: vi.fn(async () => ({ outcome: "accepted" as const, eventId: "event-1" })),
    },
    now: () => new Date(NOW_SECONDS * 1000),
  };
}

const CONFIG = {
  businessId: "business-1",
  integrationId: "integration-1",
  eventType: "generic.invoice.v1",
  maxBodyBytes: 1_024,
  signature: {
    secretRef: "secret://generic/webhook",
    header: "x-signature",
    timestampHeader: "x-timestamp",
    toleranceSeconds: 300,
  },
  deliveryIdHeader: "x-delivery-id",
  filter: { path: "event.type", equals: "invoice.paid" },
};

describe("generic signed webhook adapter", () => {
  it("persists a verified filtered event before returning 202 and deduplicates retries", async () => {
    const deps = dependencies();

    await expect(acceptGenericWebhook(CONFIG, signedRequest(), deps)).resolves.toEqual({
      status: 202,
      outcome: "accepted",
      eventId: "event-1",
    });
    expect(deps.inbox.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "business-1",
        integrationId: "integration-1",
        deliveryId: "delivery-1",
        verification: { status: "verified", method: "hmac-sha256-timestamp" },
      })
    );

    vi.mocked(deps.inbox.accept).mockResolvedValue({
      outcome: "duplicate",
      eventId: "event-1",
    });
    await expect(acceptGenericWebhook(CONFIG, signedRequest(), deps)).resolves.toEqual({
      status: 202,
      outcome: "duplicate",
      eventId: "event-1",
    });
  });

  it.each([
    {
      name: "oversize body",
      request: signedRequest({ rawBody: "x".repeat(1_025) }),
      code: "body_too_large",
    },
    {
      name: "stale timestamp",
      request: signedRequest({
        headers: { ...signedRequest().headers, "x-timestamp": "1" },
      }),
      code: "stale_timestamp",
    },
    {
      name: "signature mismatch",
      request: signedRequest({
        headers: { ...signedRequest().headers, "x-signature": "sha256=bad" },
      }),
      code: "signature_mismatch",
    },
  ] as const)("fails closed on $name without persisting", async ({ request, code }) => {
    const deps = dependencies();

    await expect(acceptGenericWebhook(CONFIG, request, deps)).rejects.toEqual(
      new GenericWebhookError(code)
    );
    expect(deps.inbox.accept).not.toHaveBeenCalled();
  });

  it("acknowledges a filtered event without creating work", async () => {
    const deps = dependencies();
    const body = JSON.stringify({ event: { type: "invoice.failed" } });
    const timestamp = String(NOW_SECONDS);
    const signature = createHmac("sha256", "webhook-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex");

    await expect(
      acceptGenericWebhook(
        CONFIG,
        signedRequest({
          rawBody: body,
          headers: {
            ...signedRequest().headers,
            "x-signature": `sha256=${signature}`,
          },
        }),
        deps
      )
    ).resolves.toEqual({ status: 202, outcome: "filtered" });
    expect(deps.inbox.accept).not.toHaveBeenCalled();
  });
});
