import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { NativeChannelError } from "../integrations/native/credentials";
import type { NativeChannelService } from "../integrations/native/service";
import { registerNativeChannelInternalRoutes } from "./native-channel-routes";

describe("native channel internal guards", () => {
  it("closes caller-principal minting and guards reply routes registered before the native feature", async () => {
    const app = Fastify();
    const legacyMint = vi.fn(async () => ({ runId: "must-not-mint" }));
    const replyRead = vi.fn(async () => ({ status: "succeeded", text: "private result" }));
    app.post("/api/v1/internal/channels/runs", legacyMint);
    app.get("/api/v1/internal/channels/runs/:runId/reply", replyRead);
    const authorizeReply = vi.fn(async () => {
      throw new NativeChannelError("native_access_denied");
    });
    registerNativeChannelInternalRoutes(
      app,
      { authorizeReply } as unknown as NativeChannelService,
      async (request) => {
        Object.assign(request, { principal: { kind: "service", id: "worker" } });
      }
    );
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/internal/channels/runs",
      payload: { principal: { kind: "user", id: "someone-else" } },
    });
    expect(minted.statusCode).toBe(403);
    expect(legacyMint).not.toHaveBeenCalled();
    const output = await app.inject({
      method: "GET",
      url: "/api/v1/internal/channels/runs/run-1/reply",
    });
    expect(output.statusCode).toBe(403);
    expect(output.body).not.toContain("private result");
    expect(authorizeReply).toHaveBeenCalledWith("run-1");
    expect(replyRead).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps a not-yet-complete dispatch pending without releasing its reply", async () => {
    const app = Fastify();
    const replyRead = vi.fn(async () => ({ status: "succeeded", text: "not yet authorized" }));
    registerNativeChannelInternalRoutes(
      app,
      {
        authorizeReply: async () => {
          throw new NativeChannelError("native_reply_not_ready", 503);
        },
      } as unknown as NativeChannelService,
      async (request) => {
        Object.assign(request, { principal: { kind: "service", id: "worker" } });
      }
    );
    app.get("/api/v1/internal/channels/runs/:runId/reply", replyRead);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/internal/channels/runs/run-1/reply",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "pending" });
    expect(replyRead).not.toHaveBeenCalled();
    await app.close();
  });
});
