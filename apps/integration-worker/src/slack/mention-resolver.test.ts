import type { IntegrationHttpPort, IntegrationHttpResponse } from "@tulipfarm/integrations";
import { describe, expect, it, vi } from "vitest";
import { slackUserDirectoryMentionResolver } from "./mention-resolver";

function fakeHttp(send: (path: string) => Promise<IntegrationHttpResponse>): IntegrationHttpPort {
  return { send: async (request) => send(request.path) };
}

const log = { warn: vi.fn() };

describe("slackUserDirectoryMentionResolver", () => {
  it("resolves display_name from the profile", async () => {
    const http = fakeHttp(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, user: { name: "mohit", profile: { display_name: "Mohit" } } },
    }));
    const resolver = slackUserDirectoryMentionResolver(http, "xoxb-token", log);

    expect(await resolver.resolveDisplayName("U0AMFGRAKLY")).toBe("Mohit");
  });

  it("falls back through profile.real_name, user.real_name, then user.name", async () => {
    const http = fakeHttp(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, user: { name: "mohit", real_name: "Mohit R", profile: {} } },
    }));
    const resolver = slackUserDirectoryMentionResolver(http, "xoxb-token", log);

    expect(await resolver.resolveDisplayName("U1")).toBe("Mohit R");
  });

  it("resolves undefined on a non-2xx response", async () => {
    const http = fakeHttp(async () => ({ status: 401, headers: {}, body: { ok: false } }));
    const resolver = slackUserDirectoryMentionResolver(http, "xoxb-token", log);

    expect(await resolver.resolveDisplayName("U1")).toBeUndefined();
  });

  it("resolves undefined on a malformed body", async () => {
    const http = fakeHttp(async () => ({ status: 200, headers: {}, body: { ok: false } }));
    const resolver = slackUserDirectoryMentionResolver(http, "xoxb-token", log);

    expect(await resolver.resolveDisplayName("U1")).toBeUndefined();
  });

  it("resolves undefined instead of throwing when the transport throws", async () => {
    const http: IntegrationHttpPort = {
      send: async () => {
        throw new Error("network down");
      },
    };
    const resolver = slackUserDirectoryMentionResolver(http, "xoxb-token", log);

    await expect(resolver.resolveDisplayName("U1")).resolves.toBeUndefined();
  });

  it("caches a resolution and does not call send twice for the same id", async () => {
    const send = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, user: { name: "mohit", profile: { display_name: "Mohit" } } },
    }));
    const resolver = slackUserDirectoryMentionResolver({ send }, "xoxb-token", log);

    await resolver.resolveDisplayName("U0AMFGRAKLY");
    await resolver.resolveDisplayName("U0AMFGRAKLY");

    expect(send).toHaveBeenCalledOnce();
  });
});
