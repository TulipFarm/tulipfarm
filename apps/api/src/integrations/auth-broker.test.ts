import { createHash } from "node:crypto";
import type { IntegrationManifest } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  AuthBrokerError,
  buildAuthorizeUrl,
  completeAuthStep,
  credentialsExpireWithin,
  type IntegrationAuthRequestDoc,
  type IntegrationAuthRequestRepo,
  mapTokenResponse,
  readPath,
  refreshOAuth2Credentials,
  renderDeep,
  renderTemplate,
  resolveAuthEndpoints,
  startAuthStep,
} from "./auth-broker";

class MemoryAuthRequestRepo implements IntegrationAuthRequestRepo {
  requests: IntegrationAuthRequestDoc[] = [];

  async create(request: IntegrationAuthRequestDoc): Promise<void> {
    this.requests.push({ ...request });
  }

  async consume(state: string): Promise<IntegrationAuthRequestDoc | null> {
    const request = this.requests.find(
      (r) => r.state === state && r.consumedAt === null && r.expiresAt > new Date()
    );
    if (!request) return null;
    request.consumedAt = new Date();
    return { ...request };
  }
}

const endpoints = {
  callbackUrl: "https://api.example.com/api/v1/integrations/auth/callback",
  webUrl: "https://app.example.com",
  apiUrl: "https://api.example.com",
};

function manifestWith(auth: IntegrationManifest["auth"]): IntegrationManifest {
  return { name: "notion", version: "1.0.0", description: "test", egress: { type: "none" }, auth };
}

const oauthStep = {
  kind: "oauth2" as const,
  authorization_url: "https://notion.example/authorize",
  token_url: "https://notion.example/token",
  client_id_env: "NOTION_CLIENT_ID",
  client_secret_env: "NOTION_CLIENT_SECRET",
  token_env: "NOTION_ACCESS_TOKEN",
  scopes: ["read", "write"],
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("renderTemplate", () => {
  it("substitutes known placeholders and leaves unknown ones intact", () => {
    expect(renderTemplate("{a}/x/{b}", { a: "1" })).toBe("1/x/{b}");
  });

  it("does not re-expand a substituted value", () => {
    // A provider-supplied value containing `{callback_url}` must stay literal, or an attacker
    // could smuggle our own endpoints into a URL we build.
    expect(renderTemplate("{a}", { a: "{callback_url}", callback_url: "https://evil" })).toBe(
      "{callback_url}"
    );
  });
});

describe("renderDeep", () => {
  it("renders nested strings, arrays, and object values", () => {
    const out = renderDeep(
      { url: "{web_url}/hook", scopes: ["{scope}"], nested: { k: "{web_url}" }, n: 3 },
      { web_url: "https://app", scope: "read" }
    );
    expect(out).toEqual({
      url: "https://app/hook",
      scopes: ["read"],
      nested: { k: "https://app" },
      n: 3,
    });
  });
});

describe("readPath", () => {
  it("reads dot paths and returns undefined for missing branches", () => {
    expect(readPath({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
    expect(readPath({ a: {} }, "a.b.c")).toBeUndefined();
    expect(readPath(null, "a")).toBeUndefined();
  });
});

describe("startAuthStep", () => {
  it("returns fields to collect without touching the provider", async () => {
    const repo = new MemoryAuthRequestRepo();
    const action = await startAuthStep({
      slug: "telegram",
      manifest: manifestWith([
        {
          kind: "fields",
          fields: [{ name: "TELEGRAM_BOT_TOKEN", label: "Bot Token", secret: true }],
        },
      ]),
      stepIndex: 0,
      env: {},
      endpoints,
      repo,
    });
    expect(action).toEqual({
      action: "collect_fields",
      fields: [{ name: "TELEGRAM_BOT_TOKEN", label: "Bot Token", secret: true }],
    });
    // No provider round trip means no state to burn.
    expect(repo.requests).toHaveLength(0);
  });

  it("builds an authorize URL with PKCE and persists the verifier server-side", async () => {
    const repo = new MemoryAuthRequestRepo();
    const action = await startAuthStep({
      slug: "notion",
      manifest: manifestWith([oauthStep]),
      stepIndex: 0,
      env: { NOTION_CLIENT_ID: "cid" },
      endpoints,
      repo,
    });
    if (action.action !== "redirect") throw new Error("expected redirect");
    const url = new URL(action.url);
    expect(url.origin + url.pathname).toBe("https://notion.example/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(endpoints.callbackUrl);
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const stored = repo.requests[0];
    expect(stored.state).toBe(url.searchParams.get("state"));
    expect(stored.codeVerifier).toBeTruthy();
    // The verifier must never appear in what the browser is handed.
    expect(action.url).not.toContain(stored.codeVerifier as string);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256")
        .update(stored.codeVerifier as string)
        .digest("base64url")
    );
  });

  it("omits PKCE when the manifest opts out", async () => {
    const repo = new MemoryAuthRequestRepo();
    const action = await startAuthStep({
      slug: "notion",
      manifest: manifestWith([{ ...oauthStep, pkce: false }]),
      stepIndex: 0,
      env: { NOTION_CLIENT_ID: "cid" },
      endpoints,
      repo,
    });
    if (action.action !== "redirect") throw new Error("expected redirect");
    expect(new URL(action.url).searchParams.has("code_challenge")).toBe(false);
    expect(repo.requests[0].codeVerifier).toBeNull();
  });

  it("refuses an oauth2 step whose client id an earlier step has not supplied", async () => {
    await expect(
      startAuthStep({
        slug: "notion",
        manifest: manifestWith([oauthStep]),
        stepIndex: 0,
        env: {},
        endpoints,
        repo: new MemoryAuthRequestRepo(),
      })
    ).rejects.toMatchObject({ reason: "missing_credentials" });
  });

  it("rejects a step index the manifest does not declare", async () => {
    await expect(
      startAuthStep({
        slug: "notion",
        manifest: manifestWith([oauthStep]),
        stepIndex: 5,
        env: {},
        endpoints,
        repo: new MemoryAuthRequestRepo(),
      })
    ).rejects.toMatchObject({ reason: "unknown_step" });
  });

  it("renders an app manifest as a form post with endpoint variables resolved", async () => {
    const repo = new MemoryAuthRequestRepo();
    const action = await startAuthStep({
      slug: "github",
      manifest: manifestWith([
        {
          kind: "app_manifest",
          create_url: "https://github.com/settings/apps/new?state={state}",
          manifest_param: "manifest",
          delivery: "form_post",
          manifest: { name: "Tulip", url: "{web_url}", hook_attributes: { url: "{api_url}/hook" } },
        },
      ]),
      stepIndex: 0,
      env: {},
      endpoints,
      repo,
    });
    if (action.action !== "form_post") throw new Error("expected form_post");
    expect(action.field).toBe("manifest");
    expect(JSON.parse(action.value)).toEqual({
      name: "Tulip",
      url: "https://app.example.com",
      hook_attributes: { url: "https://api.example.com/hook" },
    });
    expect(action.url).toContain(`state=${repo.requests[0].state}`);
  });

  it("sends the app manifest as a query param when the provider wants one", async () => {
    const repo = new MemoryAuthRequestRepo();
    const action = await startAuthStep({
      slug: "github",
      manifest: manifestWith([
        {
          kind: "app_manifest",
          create_url: "https://github.com/settings/apps/new",
          manifest_param: "manifest",
          delivery: "query_param",
          manifest: { name: "Tulip" },
        },
      ]),
      stepIndex: 0,
      env: {},
      endpoints,
      repo,
    });
    if (action.action !== "redirect") throw new Error("expected redirect");
    expect(JSON.parse(new URL(action.url).searchParams.get("manifest") as string)).toEqual({
      name: "Tulip",
    });
  });
});

describe("completeAuthStep", () => {
  const manifest = manifestWith([oauthStep]);
  const loadManifest = () => manifest;
  const loadEnv = async () => ({
    NOTION_CLIENT_ID: "cid",
    NOTION_CLIENT_SECRET: "secret",
  });

  async function startedState(repo: MemoryAuthRequestRepo): Promise<string> {
    const action = await startAuthStep({
      slug: "notion",
      manifest,
      stepIndex: 0,
      env: { NOTION_CLIENT_ID: "cid" },
      endpoints,
      repo,
    });
    if (action.action !== "redirect") throw new Error("expected redirect");
    return new URL(action.url).searchParams.get("state") as string;
  }

  it("exchanges the code and maps the token response into connection env", async () => {
    const repo = new MemoryAuthRequestRepo();
    const state = await startedState(repo);
    let sentBody = "";
    const outcome = await completeAuthStep({
      query: { state, code: "abc" },
      loadManifest,
      loadEnv,
      endpoints,
      repo,
      now: () => new Date("2026-01-01T00:00:00Z"),
      fetchImpl: async (_url, init) => {
        sentBody = String(init?.body);
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      },
    });
    expect(outcome).toMatchObject({
      slug: "notion",
      stepIndex: 0,
      env: {
        NOTION_ACCESS_TOKEN: "tok",
        NOTION_ACCESS_TOKEN_EXPIRES_AT: "2026-01-01T01:00:00.000Z",
      },
    });
    // The step itself is carried out of the exchange so a personal connect can seal the token
    // under the same env names the manifest declared, without re-resolving the manifest and
    // risking the two disagreeing about which step just ran.
    expect(outcome.oauth2Step?.kind).toBe("oauth2");
    const sent = new URLSearchParams(sentBody);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("abc");
    expect(sent.get("redirect_uri")).toBe(endpoints.callbackUrl);
    expect(sent.get("code_verifier")).toBe(repo.requests[0].codeVerifier);
  });

  it("rejects a replayed callback", async () => {
    const repo = new MemoryAuthRequestRepo();
    const state = await startedState(repo);
    const args = {
      query: { state, code: "abc" },
      loadManifest,
      loadEnv,
      endpoints,
      repo,
      fetchImpl: async () => jsonResponse({ access_token: "tok" }),
    };
    await completeAuthStep(args);
    await expect(completeAuthStep(args)).rejects.toMatchObject({ reason: "invalid_state" });
  });

  it("rejects an unknown state", async () => {
    await expect(
      completeAuthStep({
        query: { state: "nope", code: "abc" },
        loadManifest,
        loadEnv,
        endpoints,
        repo: new MemoryAuthRequestRepo(),
      })
    ).rejects.toMatchObject({ reason: "invalid_state" });
  });

  it("rejects an expired state", async () => {
    const repo = new MemoryAuthRequestRepo();
    await startAuthStep({
      slug: "notion",
      manifest,
      stepIndex: 0,
      env: { NOTION_CLIENT_ID: "cid" },
      endpoints,
      repo,
      ttlSeconds: -1,
    });
    await expect(
      completeAuthStep({
        query: { state: repo.requests[0].state, code: "abc" },
        loadManifest,
        loadEnv,
        endpoints,
        repo,
      })
    ).rejects.toMatchObject({ reason: "invalid_state" });
  });

  it("rejects a callback with no state at all", async () => {
    await expect(
      completeAuthStep({
        query: { code: "abc" },
        loadManifest,
        loadEnv,
        endpoints,
        repo: new MemoryAuthRequestRepo(),
      })
    ).rejects.toMatchObject({ reason: "invalid_state" });
  });

  it("tags the failure with the integration once the state is consumed", async () => {
    const repo = new MemoryAuthRequestRepo();
    const state = await startedState(repo);
    // A provider that redirects back with an error instead of a code.
    const err = await completeAuthStep({
      query: { state, error: "access_denied" },
      loadManifest,
      loadEnv,
      endpoints,
      repo,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthBrokerError);
    expect(err.slug).toBe("notion");
  });

  it("accepts a form-encoded token response", async () => {
    const repo = new MemoryAuthRequestRepo();
    const state = await startedState(repo);
    const outcome = await completeAuthStep({
      query: { state, code: "abc" },
      loadManifest,
      loadEnv,
      endpoints,
      repo,
      fetchImpl: async () =>
        new Response("access_token=tok&token_type=bearer", {
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
    });
    expect(outcome.env.NOTION_ACCESS_TOKEN).toBe("tok");
  });

  it("treats an error in a 200 body as a failure", async () => {
    // GitHub answers token errors with HTTP 200, so status alone cannot be trusted.
    const repo = new MemoryAuthRequestRepo();
    const state = await startedState(repo);
    await expect(
      completeAuthStep({
        query: { state, code: "abc" },
        loadManifest,
        loadEnv,
        endpoints,
        repo,
        fetchImpl: async () => jsonResponse({ error: "bad_verification_code" }),
      })
    ).rejects.toMatchObject({ reason: "exchange_failed" });
  });

  it("fails the exchange when the client secret is missing", async () => {
    const repo = new MemoryAuthRequestRepo();
    const state = await startedState(repo);
    await expect(
      completeAuthStep({
        query: { state, code: "abc" },
        loadManifest,
        loadEnv: async () => ({ NOTION_CLIENT_ID: "cid" }),
        endpoints,
        repo,
      })
    ).rejects.toMatchObject({ reason: "missing_credentials" });
  });

  it("captures install params declared by an install step", async () => {
    const installManifest = manifestWith([
      {
        kind: "install",
        url: "https://github.com/apps/x/installations/new?state={state}",
        capture: { installation_id: "GITHUB_INSTALLATION_ID" },
      },
    ]);
    const repo = new MemoryAuthRequestRepo();
    await startAuthStep({
      slug: "github",
      manifest: installManifest,
      stepIndex: 0,
      env: {},
      endpoints,
      repo,
    });
    const outcome = await completeAuthStep({
      query: { state: repo.requests[0].state, installation_id: "42", setup_action: "install" },
      loadManifest: () => installManifest,
      loadEnv: async () => ({}),
      endpoints,
      repo,
    });
    // Only declared params are captured; `setup_action` was not asked for.
    expect(outcome.env).toEqual({ GITHUB_INSTALLATION_ID: "42" });
  });

  it("converts an app manifest code into the credentials the next step needs", async () => {
    const ghManifest = manifestWith([
      {
        kind: "app_manifest",
        create_url: "https://github.com/settings/apps/new?state={state}",
        manifest_param: "manifest",
        delivery: "form_post",
        manifest: { name: "Tulip" },
        exchange: {
          url: "https://api.github.com/app-manifests/{code}/conversions",
          map: {
            id: "GITHUB_APP_ID",
            client_id: "GITHUB_CLIENT_ID",
            client_secret: "GITHUB_CLIENT_SECRET",
            pem: "GITHUB_PRIVATE_KEY",
            "owner.login": "GITHUB_APP_OWNER",
          },
        },
      },
    ]);
    const repo = new MemoryAuthRequestRepo();
    await startAuthStep({
      slug: "github",
      manifest: ghManifest,
      stepIndex: 0,
      env: {},
      endpoints,
      repo,
    });
    let calledUrl = "";
    const outcome = await completeAuthStep({
      query: { state: repo.requests[0].state, code: "conv-code" },
      loadManifest: () => ghManifest,
      loadEnv: async () => ({}),
      endpoints,
      repo,
      fetchImpl: async (url) => {
        calledUrl = String(url);
        return jsonResponse({
          id: 123,
          client_id: "Iv1.x",
          client_secret: "cs",
          pem: "-----BEGIN-----",
          owner: { login: "acme" },
        });
      },
    });
    expect(calledUrl).toBe("https://api.github.com/app-manifests/conv-code/conversions");
    expect(outcome.env).toEqual({
      GITHUB_APP_ID: "123",
      GITHUB_CLIENT_ID: "Iv1.x",
      GITHUB_CLIENT_SECRET: "cs",
      GITHUB_PRIVATE_KEY: "-----BEGIN-----",
      GITHUB_APP_OWNER: "acme",
    });
  });

  it("refuses to complete a fields step, which can never produce a callback", async () => {
    const fieldsManifest = manifestWith([{ kind: "fields", fields: [{ name: "X", label: "X" }] }]);
    const repo = new MemoryAuthRequestRepo();
    await repo.create({
      state: "s",
      integrationSlug: "x",
      stepIndex: 0,
      codeVerifier: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      principal: null,
    });
    await expect(
      completeAuthStep({
        query: { state: "s" },
        loadManifest: () => fieldsManifest,
        loadEnv: async () => ({}),
        endpoints,
        repo,
      })
    ).rejects.toMatchObject({ reason: "unknown_step" });
  });
});

describe("mapTokenResponse", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("stores a refresh token and expiry only when the provider returns them", () => {
    expect(mapTokenResponse(oauthStep, { access_token: "a" }, now)).toEqual({
      NOTION_ACCESS_TOKEN: "a",
    });
    expect(
      mapTokenResponse(oauthStep, { access_token: "a", refresh_token: "r", expires_in: 60 }, now)
    ).toEqual({
      NOTION_ACCESS_TOKEN: "a",
      NOTION_ACCESS_TOKEN_REFRESH_TOKEN: "r",
      NOTION_ACCESS_TOKEN_EXPIRES_AT: "2026-01-01T00:01:00.000Z",
    });
  });

  it("honours env names the manifest overrides", () => {
    const step = {
      ...oauthStep,
      refresh_token_env: "NOTION_REFRESH",
      expires_at_env: "NOTION_EXPIRY",
    };
    expect(
      mapTokenResponse(step, { access_token: "a", refresh_token: "r", expires_in: 60 }, now)
    ).toEqual({
      NOTION_ACCESS_TOKEN: "a",
      NOTION_REFRESH: "r",
      NOTION_EXPIRY: "2026-01-01T00:01:00.000Z",
    });
  });

  it("reads the access token from a manifest-declared path", () => {
    expect(
      mapTokenResponse(
        { ...oauthStep, token_response_path: "authed_user.access_token" },
        { authed_user: { access_token: "nested" } },
        now
      )
    ).toEqual({ NOTION_ACCESS_TOKEN: "nested" });
  });

  it("fails when the response carries no access token", () => {
    expect(() => mapTokenResponse(oauthStep, { scope: "read" }, now)).toThrow(AuthBrokerError);
  });
});

describe("credentialsExpireWithin", () => {
  const step = oauthStep;
  const now = new Date("2026-01-01T00:00:00Z");

  it("is false when no expiry was recorded", () => {
    expect(credentialsExpireWithin(step, {}, 300, now)).toBe(false);
  });

  it("is true inside the window and false outside it", () => {
    const at = (iso: string) => ({ NOTION_ACCESS_TOKEN_EXPIRES_AT: iso });
    expect(credentialsExpireWithin(step, at("2026-01-01T00:02:00Z"), 300, now)).toBe(true);
    expect(credentialsExpireWithin(step, at("2026-01-01T01:00:00Z"), 300, now)).toBe(false);
    // Already expired still counts as needing a refresh.
    expect(credentialsExpireWithin(step, at("2025-12-31T23:00:00Z"), 300, now)).toBe(true);
  });
});

describe("refreshOAuth2Credentials", () => {
  const stored = {
    NOTION_CLIENT_ID: "cid",
    NOTION_CLIENT_SECRET: "secret",
    NOTION_ACCESS_TOKEN_REFRESH_TOKEN: "r1",
  };

  it("exchanges the refresh token and keeps the old one when none is rotated back", async () => {
    let sentBody = "";
    const env = await refreshOAuth2Credentials(oauthStep, stored, {
      fetchImpl: async (_url, init) => {
        sentBody = String(init?.body);
        return jsonResponse({ access_token: "a2" });
      },
    });
    const sent = new URLSearchParams(sentBody);
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("r1");
    // The stored refresh token must survive the merge that writes this back.
    expect(env).toEqual({ NOTION_ACCESS_TOKEN: "a2", NOTION_ACCESS_TOKEN_REFRESH_TOKEN: "r1" });
  });

  it("stores a rotated refresh token", async () => {
    const env = await refreshOAuth2Credentials(oauthStep, stored, {
      fetchImpl: async () => jsonResponse({ access_token: "a2", refresh_token: "r2" }),
    });
    expect(env.NOTION_ACCESS_TOKEN_REFRESH_TOKEN).toBe("r2");
  });

  it("posts to refresh_url when the manifest declares a separate one", async () => {
    let calledUrl = "";
    await refreshOAuth2Credentials(
      { ...oauthStep, refresh_url: "https://notion.example/refresh" },
      stored,
      {
        fetchImpl: async (url) => {
          calledUrl = String(url);
          return jsonResponse({ access_token: "a2" });
        },
      }
    );
    expect(calledUrl).toBe("https://notion.example/refresh");
  });

  it("does nothing when there is no refresh token to spend", async () => {
    // A long-lived token is the normal case, not a misconfiguration, so a sweep can call blindly.
    expect(
      await refreshOAuth2Credentials(
        oauthStep,
        { NOTION_CLIENT_ID: "cid", NOTION_CLIENT_SECRET: "secret" },
        {
          fetchImpl: async () => {
            throw new Error("must not be called");
          },
        }
      )
    ).toEqual({});
  });

  it("fails loudly when the app credentials are gone", async () => {
    await expect(
      refreshOAuth2Credentials(oauthStep, { NOTION_ACCESS_TOKEN_REFRESH_TOKEN: "r1" }, {})
    ).rejects.toMatchObject({ reason: "missing_credentials" });
  });
});

describe("resolveAuthEndpoints", () => {
  it("defaults both origins to the local dev ports", () => {
    expect(resolveAuthEndpoints({} as NodeJS.ProcessEnv)).toEqual({
      apiUrl: "http://localhost:4010",
      webUrl: "http://localhost:4000",
      callbackUrl: "http://localhost:4010/api/v1/integrations/auth/callback",
    });
  });

  it("builds the callback from the public API origin, trimming trailing slashes", () => {
    expect(
      resolveAuthEndpoints({
        PUBLIC_API_URL: "https://api.example.com/",
        PUBLIC_URL: "https://app.example.com/",
      } as NodeJS.ProcessEnv).callbackUrl
    ).toBe("https://api.example.com/api/v1/integrations/auth/callback");
  });
});

describe("buildAuthorizeUrl", () => {
  it("lets manifest authorize_params override defaults", () => {
    const url = new URL(
      buildAuthorizeUrl(
        { ...oauthStep, authorize_params: { response_type: "code", owner: "user" } },
        { clientId: "cid", state: "s", redirectUri: endpoints.callbackUrl }
      )
    );
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("refuses a step with no authorization_url", () => {
    expect(() =>
      buildAuthorizeUrl(
        { ...oauthStep, authorization_url: undefined },
        { clientId: "cid", state: "s", redirectUri: endpoints.callbackUrl }
      )
    ).toThrow(AuthBrokerError);
  });
});

describe("startAuthStep — webhook registration", () => {
  const step = {
    kind: "webhook" as const,
    url: "https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/setWebhook",
    secret_env: "TELEGRAM_WEBHOOK_SECRET",
    body: { url: "{webhook_url}", secret_token: "{TELEGRAM_WEBHOOK_SECRET}", drop_pending: true },
  };

  function recordingFetch(response: { status?: number; body?: unknown } = {}) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify(response.body ?? { ok: true }), {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { calls, impl };
  }

  it("registers this deployment's ingress URL and mints the delivery secret", async () => {
    const { calls, impl } = recordingFetch();
    const action = await startAuthStep({
      slug: "telegram",
      manifest: manifestWith([step]),
      stepIndex: 0,
      env: { TELEGRAM_BOT_TOKEN: "123:AAE" },
      endpoints,
      repo: new MemoryAuthRequestRepo(),
      fetchImpl: impl,
    });

    if (action.action !== "completed") throw new Error("expected completed");
    const secret = action.env.TELEGRAM_WEBHOOK_SECRET;
    expect(secret).toBeTruthy();
    // Generated, not collected: an operator-chosen webhook secret is the most guessable
    // credential in any deployment.
    expect(secret.length).toBeGreaterThanOrEqual(32);

    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123:AAE/setWebhook");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      // Derived from the API origin, so it cannot disagree with the route that serves deliveries.
      url: "https://api.example.com/api/v1/hooks/integrations/telegram",
      secret_token: secret,
      drop_pending: true,
    });
  });

  it("does not persist state — there is no callback to come back on", async () => {
    const repo = new MemoryAuthRequestRepo();
    await startAuthStep({
      slug: "telegram",
      manifest: manifestWith([step]),
      stepIndex: 0,
      env: { TELEGRAM_BOT_TOKEN: "123:AAE" },
      endpoints,
      repo,
      fetchImpl: recordingFetch().impl,
    });
    expect(repo.requests).toHaveLength(0);
  });

  it("keeps identifiers the provider returned", async () => {
    const { impl } = recordingFetch({ body: { ok: true, result: { id: "wh_9" } } });
    const action = await startAuthStep({
      slug: "telegram",
      manifest: manifestWith([{ ...step, map: { "result.id": "TELEGRAM_WEBHOOK_ID" } }]),
      stepIndex: 0,
      env: { TELEGRAM_BOT_TOKEN: "123:AAE" },
      endpoints,
      repo: new MemoryAuthRequestRepo(),
      fetchImpl: impl,
    });
    if (action.action !== "completed") throw new Error("expected completed");
    expect(action.env.TELEGRAM_WEBHOOK_ID).toBe("wh_9");
  });

  it("stores nothing when the provider rejects the registration", async () => {
    for (const response of [{ status: 401 }, { body: { ok: false, description: "bad token" } }]) {
      const { impl } = recordingFetch(response);
      // Storing the secret without a registration behind it would leave the integration looking
      // connected while every delivery bounced.
      await expect(
        startAuthStep({
          slug: "telegram",
          manifest: manifestWith([step]),
          stepIndex: 0,
          env: { TELEGRAM_BOT_TOKEN: "123:AAE" },
          endpoints,
          repo: new MemoryAuthRequestRepo(),
          fetchImpl: impl,
        })
      ).rejects.toThrow(AuthBrokerError);
    }
  });

  it("refuses when an earlier step has not supplied the credential the URL needs", async () => {
    const { calls, impl } = recordingFetch();
    await expect(
      startAuthStep({
        slug: "telegram",
        manifest: manifestWith([step]),
        stepIndex: 0,
        env: {},
        endpoints,
        repo: new MemoryAuthRequestRepo(),
        fetchImpl: impl,
      })
    ).rejects.toThrow(/unresolved placeholders/);
    // Never send a request with `{TELEGRAM_BOT_TOKEN}` still in the path.
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-https registration URL, which would leak the secret it carries", async () => {
    const { calls, impl } = recordingFetch();
    await expect(
      startAuthStep({
        slug: "telegram",
        manifest: manifestWith([{ ...step, url: "http://api.telegram.org/setWebhook" }]),
        stepIndex: 0,
        env: { TELEGRAM_BOT_TOKEN: "123:AAE" },
        endpoints,
        repo: new MemoryAuthRequestRepo(),
        fetchImpl: impl,
      })
    ).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("never puts the credential-bearing URL in the message an operator sees", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED https://api.telegram.org/bot123:AAE/setWebhook");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      startAuthStep({
        slug: "telegram",
        manifest: manifestWith([step]),
        stepIndex: 0,
        env: { TELEGRAM_BOT_TOKEN: "123:AAE" },
        endpoints,
        repo: new MemoryAuthRequestRepo(),
        fetchImpl: impl,
      })
    ).rejects.toThrow(/could not reach the provider/);
  });
});
