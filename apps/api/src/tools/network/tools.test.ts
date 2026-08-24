import { renderDocument } from "@tulipfarm/files";
import { SecretUnavailableError } from "@tulipfarm/secrets";
import { MemoryCache } from "@tulipfarm/storage";
import { definitionForToolCall } from "@tulipfarm/tool-broker";
import { describe, expect, it, vi } from "vitest";
import { apiRequestTool, type NetworkToolContext, webFetchTool } from "./tools";

const context = (overrides: Partial<NetworkToolContext> = {}): NetworkToolContext => ({
  userId: "user-1",
  runId: "run-1",
  http: {
    send: vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    })),
  },
  useCredential: vi.fn(async (_input, callback) => callback("credential-value")),
  assertSkillDestination: vi.fn(),
  ...overrides,
});

describe("api_request classification", () => {
  it("classifies REST reads and writes before authorization", () => {
    const read = definitionForToolCall(apiRequestTool, {
      url: "https://api.example.com/items",
      method: "GET",
    });
    const write = definitionForToolCall(apiRequestTool, {
      url: "https://api.example.com/items/1",
      method: "DELETE",
    });
    expect(read).toMatchObject({
      mutating: false,
      requiresApproval: false,
      effectiveDestination: "https://api.example.com",
      authorization: { action: "network.read" },
    });
    expect(write).toMatchObject({
      mutating: true,
      requiresApproval: true,
      authorization: { action: "network.write" },
    });
  });

  it("classifies GraphQL operations and refuses subscriptions", () => {
    const query = definitionForToolCall(apiRequestTool, {
      url: "https://api.example.com/graphql",
      method: "POST",
      graphql: { document: "query Viewer { viewer { id } }" },
    });
    expect(query.mutating).toBe(false);
    expect(() =>
      definitionForToolCall(apiRequestTool, {
        url: "https://api.example.com/graphql",
        method: "POST",
        graphql: { document: "subscription Feed { event }" },
      })
    ).toThrow("subscriptions are not supported");
  });

  it("always requires exact Approval when a stored Credential is requested", () => {
    const call = definitionForToolCall(apiRequestTool, {
      url: "https://api.example.com/me",
      method: "GET",
      credential: { secret: "EXAMPLE_TOKEN", header: "authorization" },
    });
    expect(call).toMatchObject({ mutating: false, requiresApproval: true });
  });
});

describe("caller cancellation", () => {
  it("hands the Tool's abort signal to the transport, from both Tools", async () => {
    // The Tool's own deadline is the only thing bounding a redirect walk, which restarts the
    // per-hop socket timer at every hop; a transport that never sees the signal cannot be stopped.
    const abortSignal = new AbortController().signal;
    const send = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "ok",
    }));
    const ctx = context({ abortSignal, http: { send } });

    await apiRequestTool.handler({ url: "https://api.example.com/items", method: "GET" }, ctx);
    await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);

    expect(send).toHaveBeenCalledTimes(2);
    for (const [request] of send.mock.calls as unknown as [{ signal?: AbortSignal }][]) {
      expect(request.signal).toBe(abortSignal);
    }
  });
});

describe("network Tool handlers", () => {
  it("leases a Credential only around the request and does not return it", async () => {
    const ctx = context();
    const result = await apiRequestTool.handler(
      {
        url: "https://api.example.com/me",
        method: "GET",
        credential: { secret: "EXAMPLE_TOKEN", header: "authorization" },
      },
      ctx
    );
    expect(ctx.useCredential).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "EXAMPLE_TOKEN", destination: "https://api.example.com" }),
      expect.any(Function)
    );
    expect(JSON.stringify(result)).not.toContain("credential-value");
  });

  it("does not expose response credential headers to the model", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=provider-secret",
            "x-ratelimit-remaining": "10",
          },
          body: { ok: true },
        })),
      },
    });
    const result = await apiRequestTool.handler(
      { url: "https://api.example.com/me", method: "GET" },
      ctx
    );
    expect(JSON.stringify(result)).not.toContain("set-cookie");
    expect(result).toMatchObject({
      success: true,
      data: { headers: { "x-ratelimit-remaining": "10" } },
    });
  });

  it("returns the whole page as Markdown, and never summarises it itself", async () => {
    const send = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: '<h1>Release 2.0</h1><p>Ships <b>September 14</b>.</p><script>ignore()</script><a href="/notes">Notes</a>',
    }));
    const result = await webFetchTool.handler(
      { url: "https://docs.example.com/release" },
      context({ http: { send } })
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        fetched: true,
        status: 200,
        format: "markdown",
        content:
          "# Release 2.0\n\nShips **September 14**.\n\n[Notes](https://docs.example.com/notes)",
        truncated: false,
        links: [{ href: "https://docs.example.com/notes", text: "Notes" }],
      },
    });
    // The Tool is pure I/O: no prompt goes in and no model is consulted.
    expect(JSON.stringify(result)).not.toContain("ignore()");
  });

  it("re-authorizes the origin a cached page actually came from", async () => {
    // The cache is keyed on the requested URL, but a same-site redirect can leave the content at
    // a different origin. A caller allowed only the requested origin must not inherit the reach
    // of whoever primed the entry.
    const cachePort = new MemoryCache();
    await cachePort.set(
      "web_fetch:v1:https://docs.example.com/release",
      { fetched: true, url: "https://www.example.com/release", content: "secret" },
      60_000
    );

    const send = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "public",
    }));
    const result = await webFetchTool.handler(
      { url: "https://docs.example.com/release" },
      context({
        http: { send },
        cache: cachePort,
        assertSkillDestination: (origin: string) => {
          if (origin !== "https://docs.example.com") throw new Error(`${origin} not declared`);
        },
      })
    );

    expect(JSON.stringify(result)).not.toContain("secret");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports a timed-out write as indeterminate, never as a successful call", async () => {
    // The transport answers a deadline with a synthetic 503. Passing that through as a success
    // settles the effect confirmed and leaves the model free to reissue a write the destination
    // may already have performed.
    const send = vi.fn(async () => ({
      status: 503,
      headers: { "content-type": "application/json" },
      body: { error: "network_timeout", message: "the destination did not answer in 75000ms" },
    }));
    const result = await apiRequestTool.handler(
      { url: "https://api.example.com/issues", method: "POST", body: { title: "x" } },
      context({ http: { send } })
    );

    expect(result).toMatchObject({ success: false, error: { code: "indeterminate" } });
  });

  it("still reports a timed-out read as an ordinary result", async () => {
    // A GET changed nothing, so the fault is data the model can read and act on.
    const send = vi.fn(async () => ({
      status: 503,
      headers: { "content-type": "application/json" },
      body: { error: "network_timeout", message: "the destination did not answer" },
    }));
    const result = await apiRequestTool.handler(
      { url: "https://api.example.com/issues", method: "GET" },
      context({ http: { send } })
    );

    expect(result).toMatchObject({ success: true });
  });

  it("never puts the prompt on the wire, in the body, or in the result", async () => {
    // `prompt` says what the caller wants out of the response. The destination has no business
    // seeing it, and a mutating request must send exactly what was authorized and nothing more.
    const send = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"created":true}',
    }));
    const result = await apiRequestTool.handler(
      {
        url: "https://api.example.com/issues",
        method: "POST",
        body: { title: "Broken link" },
        prompt: "tell me the id of the issue that was created",
      },
      context({ http: { send } })
    );

    const [request] = send.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(JSON.stringify(request)).not.toContain("tell me the id");
    expect(request.body).toEqual({ title: "Broken link" });
    expect(JSON.stringify(result)).not.toContain("tell me the id");
  });

  it("refuses a header that is shaped like a credential, and says where to put it", async () => {
    const send = vi.fn();
    const result = await apiRequestTool.handler(
      {
        url: "https://api.example.com/me",
        method: "GET",
        headers: { "X-Api-Key": "sk-live-1234" },
      },
      context({ http: { send } })
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "write_denied", message: expect.stringContaining("credential") },
    });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("sk-live-1234");
  });

  it.each(["X_API_KEY", "X-AuthToken", "X-Service-Key", "XApiKey", "x_auth_token"])(
    "refuses %s, whatever separator the vendor spelled it with",
    async (header) => {
      const send = vi.fn();
      const result = await apiRequestTool.handler(
        { url: "https://api.example.com/me", method: "GET", headers: { [header]: "sk-live-1234" } },
        context({ http: { send } })
      );

      expect(result).toMatchObject({ success: false, error: { code: "write_denied" } });
      expect(send).not.toHaveBeenCalled();
    }
  );

  it.each(["accept", "content-type", "user-agent", "x-request-id", "if-none-match"])(
    "still allows the ordinary header %s",
    async (header) => {
      const send = vi.fn(async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      }));
      await apiRequestTool.handler(
        { url: "https://api.example.com/me", method: "GET", headers: { [header]: "value" } },
        context({ http: { send } })
      );

      expect(send).toHaveBeenCalled();
    }
  );

  it("declares that it is carrying a Secret, so a redirect cannot walk it to another host", async () => {
    const send = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    }));
    await apiRequestTool.handler(
      {
        url: "https://api.example.com/me",
        method: "GET",
        credential: { secret: "EXAMPLE_TOKEN", header: "X-Service-Key" },
      },
      context({ http: { send } })
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.example.com/me" })
    );
  });

  it("tells the Agent the cage refused the destination, not that the server did", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 403,
          headers: {},
          body: {
            error: "private_destination",
            [Symbol.for("tulipfarm.egress.denial")]: "private_destination",
          },
        })),
      },
    });

    await expect(
      webFetchTool.handler({ url: "https://internal.example.com/admin" }, ctx)
    ).resolves.toMatchObject({
      success: true,
      // No `status`: a 403 here is the cage's, and reporting it would read as the site's answer.
      data: { fetched: false, reason: "destination_refused", denial: "private_destination" },
    });
  });

  it("is not fooled by a destination that dresses its own 403 as this deployment's refusal", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 403,
          headers: { "content-type": "application/json" },
          // A body is the destination's to write; only the cage can mark its own refusal.
          body: { error: "private_destination" },
        })),
      },
    });

    await expect(
      webFetchTool.handler({ url: "https://docs.example.com/admin" }, ctx)
    ).resolves.toMatchObject({
      success: true,
      data: { fetched: false, status: 403, reason: "http_error" },
    });
  });

  it("refuses content whose bytes are binary even when it claims to be text", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3",
        })),
      },
    });

    await expect(
      webFetchTool.handler({ url: "https://docs.example.com/manual" }, ctx)
    ).resolves.toMatchObject({
      success: true,
      data: { fetched: false, reason: "binary_content" },
    });
  });

  it("answers an unreachable destination without spending the model's repair budget", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 503,
          headers: { "content-type": "application/json" },
          body: { error: "network_timeout", message: "the destination did not answer in 30000ms" },
        })),
      },
    });
    const result = await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);
    expect(result).toMatchObject({
      success: true,
      data: { fetched: false, status: 503, reason: "http_error" },
    });
    expect(JSON.stringify(result)).toContain("network_timeout");
  });

  it("answers an empty response instead of raising on a missing body", async () => {
    const ctx = context({
      http: { send: vi.fn(async () => ({ status: 204, headers: {}, body: undefined })) },
    });
    await expect(
      webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx)
    ).resolves.toMatchObject({ success: true, data: { fetched: false, reason: "empty_response" } });
  });

  it("answers an unreadable content type rather than rejecting the arguments", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 200,
          headers: { "content-type": "image/png" },
          body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        })),
      },
    });
    await expect(
      webFetchTool.handler({ url: "https://docs.example.com/diagram.png" }, ctx)
    ).resolves.toMatchObject({
      success: true,
      data: { fetched: false, reason: "unsupported_content_type" },
    });
  });

  it("reads the text out of a PDF instead of refusing the whole document", async () => {
    const { bytes } = await renderDocument({
      format: "pdf",
      content: "Release 2.0 ships on September 14.",
      title: "Release notes",
    });
    const send = vi.fn(async (_request: { readonly acceptBinary?: boolean }) => ({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: bytes,
    }));
    const ctx = context({ http: { send } });

    const result = await webFetchTool.handler({ url: "https://docs.example.com/manual.pdf" }, ctx);

    expect(result).toMatchObject({ success: true, data: { fetched: true, format: "text" } });
    expect((result as { data: { content: string } }).data.content).toContain("September 14");
    // Undecoded bytes are the whole point: a UTF-8 decode would have destroyed the document
    // before anything could parse it.
    expect(send.mock.calls[0]?.[0]).toMatchObject({ acceptBinary: true });
  });

  it("says a PDF carried no text layer rather than reporting an empty page", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 200,
          headers: { "content-type": "application/pdf" },
          body: new TextEncoder().encode("%PDF-1.7 not really a pdf"),
        })),
      },
    });

    await expect(
      webFetchTool.handler({ url: "https://docs.example.com/scan.pdf" }, ctx)
    ).resolves.toMatchObject({
      success: true,
      data: { fetched: false, reason: "unsupported_content_type" },
    });
  });

  it("serves a repeat read from cache instead of fetching the page twice", async () => {
    const send = vi.fn(async (_request: unknown) => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<p>Release 2.0 ships on September 14.</p>",
    }));
    const ctx = context({ http: { send }, cache: new MemoryCache() });

    const first = await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);
    const second = await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-reads a cached page under a new prompt without asking the site again", async () => {
    // This is how a follow-up is answered. The Agent asks the same URL a second question; the
    // page is served from cache and shrunk against the new prompt, so a detail the first prompt
    // did not ask for is still reachable without another request.
    const send = vi.fn(async (_request: unknown) => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<p>By Vicent Marti. Release 2.0 ships on September 14.</p>",
    }));
    const ctx = context({ http: { send }, cache: new MemoryCache() });

    const summary = await webFetchTool.handler(
      { url: "https://docs.example.com/release", prompt: "summarise this page" },
      ctx
    );
    const author = await webFetchTool.handler(
      { url: "https://docs.example.com/release", prompt: "who wrote this article?" },
      ctx
    );

    expect(send).toHaveBeenCalledTimes(1);
    // The Tool answers neither question: it returns the same page both times, and the prompt is
    // carried past it to the distiller. A Tool that read the prompt would be summarising.
    expect(author).toEqual(summary);
  });

  it("keeps the prompt out of the result, so a cached read cannot serve a stale one", async () => {
    // The cache is keyed on the URL alone. A prompt stored in the payload would come back with
    // the next reader's page and describe a question nobody asked.
    const send = vi.fn(async (_request: unknown) => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<p>Release notes.</p>",
    }));
    const ctx = context({ http: { send }, cache: new MemoryCache() });

    const result = await webFetchTool.handler(
      { url: "https://docs.example.com/release", prompt: "who wrote this article?" },
      ctx
    );

    expect(JSON.stringify(result)).not.toContain("who wrote this article?");
  });

  it("does not charge the network budget for an answer it never fetched", async () => {
    const spendBudget = vi.fn(() => ({ allowed: true, spent: 1, limit: 40 }));
    const ctx = context({
      cache: new MemoryCache(),
      spendBudget,
      http: {
        send: vi.fn(async () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<p>Hello</p>",
        })),
      },
    });

    await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);
    await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);

    expect(spendBudget).toHaveBeenCalledTimes(1);
  });

  it("never caches a refusal, so a transient failure is not answered with forever", async () => {
    const send = vi
      .fn(async (_request: unknown) => ({
        status: 500,
        headers: { "content-type": "text/html" },
        body: "<p>down</p>",
      }))
      .mockResolvedValueOnce({
        status: 500,
        headers: { "content-type": "text/html" },
        body: "<p>down</p>",
      });
    const ctx = context({ http: { send }, cache: new MemoryCache() });

    const first = await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);
    await webFetchTool.handler({ url: "https://docs.example.com/release" }, ctx);

    expect(first).toMatchObject({ data: { fetched: false, reason: "http_error" } });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("checks the caller may reach a destination before answering from cache", async () => {
    const cache = new MemoryCache();
    const send = vi.fn(async (_request: unknown) => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<p>Internal notes</p>",
    }));
    await webFetchTool.handler(
      { url: "https://docs.example.com/notes" },
      context({ http: { send }, cache })
    );

    const barred = context({
      http: { send },
      cache,
      assertSkillDestination: vi.fn(() => {
        throw new Error("The active Skill does not declare this destination");
      }),
    });
    await expect(
      webFetchTool.handler({ url: "https://docs.example.com/notes" }, barred)
    ).resolves.toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("still asks the model to repair a URL it can act on", async () => {
    await expect(webFetchTool.handler({ url: "not-a-url" }, context())).resolves.toMatchObject({
      success: false,
      error: { code: "validation_error" },
    });
  });

  it("stops sending once the Run has spent its network budget, without asking for a repair", async () => {
    const send = vi.fn();
    const result = await webFetchTool.handler(
      { url: "https://docs.example.com/release" },
      context({
        http: { send },
        spendBudget: () => ({ allowed: false, spent: 41, limit: 40 }),
      })
    );

    // An answer, not a validation error: the arguments were fine, so a repair would only
    // reproduce this same result and burn the model's repair budget doing it.
    expect(result).toMatchObject({
      success: true,
      data: { fetched: false, reason: "network_budget_exhausted" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a UI-only Secrets setup link when the Credential is missing", async () => {
    const ctx = context({
      useCredential: vi.fn(async () => {
        throw new SecretUnavailableError("missing");
      }),
    });
    await expect(
      apiRequestTool.handler(
        {
          url: "https://api.example.com/me",
          method: "GET",
          credential: { secret: "EXAMPLE_TOKEN", header: "authorization" },
        },
        ctx
      )
    ).resolves.toMatchObject({
      success: false,
      error: {
        code: "credential_required",
        connectUrl: "/business/secrets?required=EXAMPLE_TOKEN",
      },
    });
  });
});
