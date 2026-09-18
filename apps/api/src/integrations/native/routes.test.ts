import { createHmac } from "node:crypto";
import { verifyNativeWebhook } from "@tulipfarm/integrations";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { RequireAuthorization } from "../../authz/route-gate";
import { registerNativeChannelRoutes } from "./routes";
import type { NativeChannelService } from "./service";

describe("native channel webhook routes", () => {
  it("passes the exact signed bytes and does not acknowledge until persistence completes", async () => {
    const app = Fastify();
    const body = '{ "action" : "created", "installation": {"id":42} }';
    let release: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accepted = vi.fn(
      async (
        provider: Parameters<NativeChannelService["accept"]>[0],
        rawBody: Buffer,
        headers: Parameters<NativeChannelService["accept"]>[2]
      ) => {
        verifyNativeWebhook({ provider, rawBody, headers, secret: "webhook-test-secret" });
        expect(rawBody.toString()).toBe(body);
        await committed;
        return { outcome: "accepted", eventId: "durable-event-1" };
      }
    );
    registerNativeChannelRoutes(
      app,
      {
        service: { deps: {}, accept: accepted } as unknown as NativeChannelService,
        publicApiUrl: () => "https://api.example.test",
      },
      async () => {},
      (() => async () => {}) as RequireAuthorization
    );
    await app.ready();
    let acknowledged = false;
    const response = app
      .inject({
        method: "POST",
        url: "/api/v1/integrations/native/github/events",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-1",
          "x-github-event": "issue_comment",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "webhook-test-secret")
            .update(body)
            .digest("hex")}`,
        },
        payload: body,
      })
      .then((value) => {
        acknowledged = true;
        return value;
      });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    release?.();
    expect((await response).json()).toEqual({ outcome: "accepted", eventId: "durable-event-1" });
    await app.close();
  });

  it("rejects an invalid signature without a successful acknowledgement", async () => {
    const app = Fastify();
    registerNativeChannelRoutes(
      app,
      {
        service: {
          deps: {},
          accept: async (provider: "github", rawBody: Buffer, headers: Record<string, string>) =>
            verifyNativeWebhook({ provider, rawBody, headers, secret: "webhook-test-secret" }),
        } as unknown as NativeChannelService,
        publicApiUrl: () => "https://api.example.test",
      },
      async () => {},
      (() => async () => {}) as RequireAuthorization
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/native/github/events",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
