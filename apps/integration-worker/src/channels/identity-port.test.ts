import { describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "../internal/client";
import { httpChannelIdentityPort } from "./identity-port";

function client(fetchImpl: typeof globalThis.fetch): InternalApiClient {
  return new InternalApiClient({
    baseUrl: "http://api.internal",
    credential: "tfc_client.secret",
    fetch: fetchImpl,
  });
}

describe("httpChannelIdentityPort", () => {
  it("resolves a linked sender to its own principal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ linked: true, principal: { kind: "user", id: "user-1" } }), {
        status: 200,
      })
    );

    const result = await httpChannelIdentityPort(client(fetchImpl)).resolve({
      businessId: "business-1",
      provider: "slack",
      externalSubject: "U1",
    });

    expect(result).toEqual({ kind: "user", id: "user-1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.internal/api/v1/internal/channels/identity/resolve");
    expect(JSON.parse(init.body as string)).toEqual({
      provider: "slack",
      externalSubject: "U1",
    });
  });

  it("returns undefined for an unlinked sender, never substituting a principal", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ linked: false }), { status: 200 }));

    const result = await httpChannelIdentityPort(client(fetchImpl)).resolve({
      businessId: "business-1",
      provider: "slack",
      externalSubject: "U-UNKNOWN",
    });

    expect(result).toBeUndefined();
  });
});
