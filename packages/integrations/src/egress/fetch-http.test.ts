import { describe, expect, it, vi } from "vitest";
import { FetchEgressHttp } from "./fetch-http";

const request = { url: "https://example.com/data", method: "GET", headers: {} } as const;

describe("FetchEgressHttp", () => {
  it("stops reading once the response byte ceiling is crossed", async () => {
    const fetch = vi.fn(async () => new Response("12345", { status: 200 }));
    const http = new FetchEgressHttp({
      fetch: fetch as typeof globalThis.fetch,
      maxResponseBytes: 4,
    });
    await expect(http.send(request)).resolves.toEqual({
      status: 413,
      headers: {},
      body: { error: "response_too_large" },
    });
  });

  it("keeps redirects manual so the caller can reauthorize the next origin", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/path" },
        })
    );
    const http = new FetchEgressHttp({ fetch: fetch as typeof globalThis.fetch });
    await expect(http.send(request)).resolves.toMatchObject({
      status: 302,
      headers: { location: "https://other.example/path" },
    });
    expect(fetch).toHaveBeenCalledWith(
      request.url,
      expect.objectContaining({ redirect: "manual" })
    );
  });
});
