import { SecretUnavailableError } from "@tulipfarm/secrets";
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
  extract: vi.fn(async ({ content }) => `extracted:${content}`),
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

  it("extracts a public page using the caller's prompt", async () => {
    const ctx = context({
      http: {
        send: vi.fn(async () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<h1>Release 2.0</h1><script>ignore()</script>",
        })),
      },
    });
    const result = await webFetchTool.handler(
      { url: "https://docs.example.com/release", prompt: "What version is this?" },
      ctx
    );
    expect(ctx.extract).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "What version is this?", content: "Release 2.0" })
    );
    expect(result).toMatchObject({ success: true });
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
