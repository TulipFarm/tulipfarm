import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { FetchEgressHttp } from "./fetch-http";

const request = { url: "https://example.com/data", method: "GET", headers: {} } as const;

describe("FetchEgressHttp", () => {
  it("streams multipart bytes to the provider without serialising them as JSON", async () => {
    const fileBytes = new TextEncoder().encode("private-file-bytes");
    let received = "";
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
        received += new TextDecoder().decode(chunk);
      }
      return new Response('{"ok":true}', { status: 200 });
    });
    const http = new FetchEgressHttp({ fetch: fetch as typeof globalThis.fetch });

    await http.send({
      url: request.url,
      method: "POST",
      headers: {},
      multipart: [
        { name: "metadata", body: '{"title":"Report"}' },
        {
          name: "file",
          filename: "report.pdf",
          mediaType: "application/pdf",
          body: (async function* () {
            yield fileBytes;
          })(),
        },
      ],
    });

    expect(received).toContain('name="file"; filename="report.pdf"');
    expect(received).toContain("private-file-bytes");
    expect(fetch).toHaveBeenCalledWith(
      request.url,
      expect.objectContaining({
        headers: expect.objectContaining({
          "content-type": expect.stringMatching(/^multipart\/form-data/),
        }),
      })
    );
  });

  it("streams a binary response into the host-owned sink beyond the Tool response limit", async () => {
    const bytes = new Uint8Array(32);
    let stored = 0;
    const http = new FetchEgressHttp({
      fetch: (async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "32" },
        })) as typeof globalThis.fetch,
      maxResponseBytes: 8,
    });

    await expect(
      http.send({
        ...request,
        binaryResponse: async ({ body, declaredBytes }) => {
          expect(declaredBytes).toBe(32);
          for await (const chunk of body) stored += chunk.byteLength;
          return { fileId: "file-1" };
        },
      })
    ).resolves.toMatchObject({ status: 200, body: { fileId: "file-1" } });
    expect(stored).toBe(32);
  });

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

  it("uses a stricter operation response ceiling", async () => {
    const fetch = vi.fn(async () => new Response("12345", { status: 200 }));
    const http = new FetchEgressHttp({
      fetch: fetch as typeof globalThis.fetch,
      maxResponseBytes: 100,
    });

    await expect(http.send({ ...request, maxResponseBytes: 4 })).resolves.toEqual({
      status: 413,
      headers: {},
      body: { error: "response_too_large" },
    });
  });

  it("aborts the socket when the caller's own deadline fires", async () => {
    // Without this the request outlives the Tool that issued it: the caller has already been
    // told the call failed while a mutating request is still on the wire.
    const caller = new AbortController();
    const http = new FetchEgressHttp({
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true }
          );
        })) as unknown as typeof globalThis.fetch,
      timeoutMs: 60_000,
    });

    const sent = http.send({ ...request, signal: caller.signal });
    caller.abort();

    await expect(sent).resolves.toMatchObject({ status: 503 });
  });

  it("still bounds a caller that passes no signal", async () => {
    const http = new FetchEgressHttp({
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
            { once: true }
          );
        })) as unknown as typeof globalThis.fetch,
      timeoutMs: 20,
    });

    await expect(http.send(request)).resolves.toMatchObject({ status: 503 });
  });

  it("carries the cause of a network fault instead of an empty 503", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const http = new FetchEgressHttp({
      fetch: (async () => {
        throw timeout;
      }) as typeof globalThis.fetch,
      timeoutMs: 1_000,
    });
    await expect(http.send(request)).resolves.toEqual({
      status: 503,
      headers: { "content-type": "application/json" },
      body: { error: "network_timeout", message: "the destination did not answer in 1000ms" },
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

  it("connects over a pinned address instead of reporting a spurious network fault", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const http = new FetchEgressHttp();
      // A named host, pinned to a resolved address the way GuardedEgressHttp does it — undici's
      // connector only exercises the custom `lookup` when the URL host isn't already a literal IP.
      await expect(
        http.send({
          url: `http://pinned.invalid:${port}/`,
          method: "GET",
          headers: {},
          pinnedAddresses: ["127.0.0.1"],
        })
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
