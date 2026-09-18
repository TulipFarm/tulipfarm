import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMcpOAuthClient, type McpOAuthDiscovery, type McpOAuthRegistration } from "./oauth";

const discovery: McpOAuthDiscovery = {
  serverUrl: "https://mcp.example.test/mcp",
  resource: "https://mcp.example.test/mcp",
  issuer: "https://auth.example.test/",
  authorizationEndpoint: "https://auth.example.test/authorize",
  tokenEndpoint: "https://auth.example.test/token",
  registrationEndpoint: "https://auth.example.test/register",
  codeChallengeMethodsSupported: ["S256"],
  tokenEndpointAuthMethodsSupported: ["none", "client_secret_basic", "client_secret_post"],
};
const registration: McpOAuthRegistration = {
  clientId: "registered-client",
  tokenEndpointAuthMethod: "none",
};
const redirectUri = "https://tulip.example.test/api/oauth/callback";

function fixture() {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (value: string | URL, init?: RequestInit) => {
    const url = String(value);
    requests.push({ url, init });
    if (url.includes("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: discovery.resource,
        authorization_servers: [discovery.issuer],
      });
    }
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return Response.json({
        issuer: discovery.issuer,
        authorization_endpoint: discovery.authorizationEndpoint,
        token_endpoint: discovery.tokenEndpoint,
        registration_endpoint: discovery.registrationEndpoint,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: discovery.tokenEndpointAuthMethodsSupported,
      });
    }
    if (url === discovery.registrationEndpoint) {
      return Response.json(
        {
          client_id: registration.clientId,
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        },
        { status: 201 }
      );
    }
    if (url === discovery.tokenEndpoint) {
      const body = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token:
          body.get("grant_type") === "refresh_token" ? "refreshed-token" : "access-token",
        token_type: "Bearer",
        expires_in: 3600,
        ...(body.get("grant_type") === "refresh_token" ? {} : { refresh_token: "refresh-token" }),
      });
    }
    return new Response(null, { status: 404 });
  });
  const validateUrl = vi.fn(async (value: string) => {
    const url = new URL(value);
    if (!["mcp.example.test", "auth.example.test", "tulip.example.test"].includes(url.hostname)) {
      throw new Error("destination denied");
    }
  });
  return { client: createMcpOAuthClient({ fetch, validateUrl }), fetch, validateUrl, requests };
}

describe("guarded MCP OAuth primitives", () => {
  it("discovers actual RFC metadata and runs DCR, S256 code exchange, and refresh through SDK", async () => {
    const f = fixture();
    const discovered = await f.client.discover({ serverUrl: discovery.serverUrl });
    expect(discovered).toEqual(discovery);
    const client = await f.client.register({
      discovery: discovered,
      redirectUri,
      clientName: "TulipFarm",
    });
    expect(client).toEqual(registration);
    const started = await f.client.start({
      discovery: discovered,
      client,
      redirectUri,
      state: "host-generated-single-use-state",
      scope: "read",
    });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get("state")).toBe("host-generated-single-use-state");
    expect(authorization.searchParams.get("resource")).toBe(discovery.resource);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(started.codeVerifier).digest("base64url")
    );
    expect(
      await f.client.exchange({
        discovery: discovered,
        client,
        redirectUri,
        authorizationCode: "provider-code",
        codeVerifier: started.codeVerifier,
      })
    ).toEqual({
      accessToken: "access-token",
      tokenType: "Bearer",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    });
    expect(
      await f.client.refresh({ discovery: discovered, client, refreshToken: "refresh-token" })
    ).toMatchObject({ accessToken: "refreshed-token", refreshToken: "refresh-token" });
    for (const request of f.requests) {
      expect(request.init).toMatchObject({ redirect: "manual", credentials: "omit" });
    }
    const exchanges = f.requests.filter((request) => request.url === discovery.tokenEndpoint);
    expect(exchanges).toHaveLength(2);
    const codeBody = new URLSearchParams(String(exchanges[0]?.init?.body));
    expect(codeBody.get("code_verifier")).toBe(started.codeVerifier);
    expect(codeBody.get("resource")).toBe(discovery.resource);
  });

  it("supports explicitly pre-registered confidential clients without dynamic registration", async () => {
    const f = fixture();
    const configured: McpOAuthRegistration = {
      clientId: "fixed-app",
      clientSecret: "client-secret",
      tokenEndpointAuthMethod: "client_secret_basic",
    };
    await f.client.refresh({ discovery, client: configured, refreshToken: "refresh-token" });
    expect(f.requests).toHaveLength(1);
    expect(new Headers(f.requests[0]?.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("fixed-app:client-secret").toString("base64")}`
    );
  });

  it("refuses unknown PKCE support, resource mismatch, and unapproved endpoints", async () => {
    const f = fixture();
    const start = { discovery, client: registration, redirectUri, state: "state" };
    await expect(
      f.client.start({ ...start, discovery: { ...discovery, codeChallengeMethodsSupported: [] } })
    ).rejects.toMatchObject({ reason: "unsupported" });
    await expect(
      f.client.start({
        ...start,
        discovery: { ...discovery, resource: "https://auth.example.test/" },
      })
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    await expect(
      f.client.start({
        ...start,
        discovery: { ...discovery, authorizationEndpoint: "https://unapproved.test/auth" },
      })
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("refuses metadata redirects without a second network request", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://unapproved.test/" },
        })
    );
    const client = createMcpOAuthClient({ fetch, validateUrl: async () => {} });
    await expect(client.discover({ serverUrl: discovery.serverUrl })).rejects.toMatchObject({
      code: "access_denied",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not turn metadata authorization failures into successful fallback discovery", async () => {
    const fetch = vi.fn(async () => new Response("secret response", { status: 403 }));
    const client = createMcpOAuthClient({ fetch, validateUrl: async () => {} });
    await expect(client.discover({ serverUrl: discovery.serverUrl })).rejects.toMatchObject({
      code: "protocol_failure",
      httpStatus: 403,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a typed invalid-grant error without leaking token responses or retrying", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "secret-refresh-token",
        },
        { status: 400 }
      )
    );
    const client = createMcpOAuthClient({ fetch, validateUrl: async () => {} });
    await expect(
      client.refresh({ discovery, client: registration, refreshToken: "secret-refresh-token" })
    ).rejects.toMatchObject({ reason: "invalid_grant", message: "MCP authentication required" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
