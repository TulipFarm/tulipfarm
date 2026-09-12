import type { OimManifest } from "@tulipfarm/schema";
import type { PersistedConnection } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl } from "./auth-broker";
import {
  OIM_OAUTH_STEP_INDEX,
  oimAuthLegacyManifest,
  oimConnectionPatchFromEnv,
  oimCredentialsFromEnv,
  oimLegacyStepIndex,
  oimOAuthLegacyManifest,
  oimSlotEnv,
  refreshOimOAuthStep,
} from "./oim-oauth";

/**
 * What matters here is that translation is faithful: an OIM package must produce the same
 * authorize URL a hand-written legacy step would, because that is what makes reusing the broker
 * safe rather than merely tidy.
 */

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      description: "Do acme things.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [
        { id: "client_id", label: "Client id", kind: "api_key", required: true },
        { id: "client_secret", label: "Client secret", kind: "client_secret" },
        { id: "access_token", label: "Access token", kind: "oauth2_access_token", required: true },
        { id: "refresh_token", label: "Refresh token", kind: "oauth2_refresh_token" },
        { id: "workspace_id", label: "Workspace", kind: "api_key" },
      ],
      allowedOriginHosts: ["api.acme.test"],
      steps: [
        {
          id: "consent",
          title: "Authorize Acme",
          type: "oauth2",
          authorizationUrl: "https://acme.test/oauth/authorize",
          tokenUrl: "https://acme.test/oauth/token",
          scopes: ["read:things", "write:things"],
          pkce: true,
          clientId: { type: "credential", slot: "client_id" },
          clientSecret: { type: "credential", slot: "client_secret" },
          bindings: [
            { sourcePath: "/access_token", target: { type: "credential", slot: "access_token" } },
            { sourcePath: "/refresh_token", target: { type: "credential", slot: "refresh_token" } },
            {
              sourcePath: "/workspace/id",
              target: { type: "credential", slot: "workspace_id" },
            },
          ],
        },
      ],
    },
    operations: [],
  } as unknown as OimManifest;
}

describe("oimOAuthLegacyManifest", () => {
  it("puts the OAuth step at the index callers address it by", () => {
    const legacy = oimOAuthLegacyManifest(manifest());
    expect(legacy?.auth?.[OIM_OAUTH_STEP_INDEX]?.kind).toBe("oauth2");
    expect(legacy?.auth?.[0]?.kind).toBe("fields");
  });

  it("produces the authorize URL a hand-written legacy step would", () => {
    const legacy = oimOAuthLegacyManifest(manifest());
    const step = legacy?.auth?.[OIM_OAUTH_STEP_INDEX];
    if (step?.kind !== "oauth2") throw new Error("expected an oauth2 step");

    const url = buildAuthorizeUrl(step, {
      clientId: "cid",
      state: "st",
      codeChallenge: "cc",
      redirectUri: "https://tf.test/cb",
    });
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe("https://acme.test/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("cid");
    expect(parsed.searchParams.get("state")).toBe("st");
    expect(parsed.searchParams.get("code_challenge")).toBe("cc");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://tf.test/cb");
    expect(parsed.searchParams.get("scope")).toBe("read:things write:things");
  });

  it("preserves declared provider parameters while keeping protocol parameters host-owned", () => {
    const source = manifest();
    const oauth = source.auth?.steps[0];
    if (oauth?.type !== "oauth2") throw new Error("expected an oauth2 step");
    oauth.authorizationParameters = {
      access_type: "offline",
      prompt: "consent",
      client_id: "untrusted",
      redirect_uri: "https://evil.test",
      state: "untrusted",
      scope: "untrusted",
      code_challenge: "untrusted",
      code_challenge_method: "plain",
    };

    const steps = [
      oimOAuthLegacyManifest(source)?.auth?.[OIM_OAUTH_STEP_INDEX],
      oimAuthLegacyManifest(source).auth?.[0],
    ];

    for (const step of steps) {
      if (step?.kind !== "oauth2") throw new Error("expected an oauth2 step");
      const parsed = new URL(
        buildAuthorizeUrl(step, {
          clientId: "cid",
          state: "st",
          redirectUri: "https://tf.test/cb",
        })
      );

      expect(parsed.searchParams.get("access_type")).toBe("offline");
      expect(parsed.searchParams.get("prompt")).toBe("consent");
      expect(parsed.searchParams.get("client_id")).toBe("cid");
      expect(parsed.searchParams.get("redirect_uri")).toBe("https://tf.test/cb");
      expect(parsed.searchParams.get("state")).toBe("st");
      expect(parsed.searchParams.get("scope")).toBe("read:things write:things");
      expect(parsed.searchParams.has("code_challenge")).toBe(false);
      expect(parsed.searchParams.has("code_challenge_method")).toBe(false);
    }
  });

  it("keeps every non-token binding, so a workspace id survives the exchange", () => {
    const step = oimOAuthLegacyManifest(manifest())?.auth?.[OIM_OAUTH_STEP_INDEX];
    if (step?.kind !== "oauth2") throw new Error("expected an oauth2 step");
    expect(step.map).toEqual({ "workspace.id": oimSlotEnv("workspace_id") });
    expect(step.refresh_token_env).toBe(oimSlotEnv("refresh_token"));
  });

  it("preserves the declared token endpoint client authentication method", () => {
    const source = manifest();
    const oauth = source.auth?.steps[0];
    if (oauth?.type !== "oauth2") throw new Error("expected an oauth2 step");
    oauth.tokenEndpointAuthMethod = "client_secret_basic";

    const translated = oimAuthLegacyManifest(source).auth?.[0] as
      | { kind: "oauth2"; token_endpoint_auth_method?: string }
      | undefined;
    expect(translated?.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("marks the step personal only when the connect request was personal", () => {
    const shared = oimOAuthLegacyManifest(manifest())?.auth?.[OIM_OAUTH_STEP_INDEX];
    const mine = oimOAuthLegacyManifest(manifest(), { personal: true })?.auth?.[
      OIM_OAUTH_STEP_INDEX
    ];
    if (shared?.kind !== "oauth2" || mine?.kind !== "oauth2") throw new Error("expected oauth2");
    expect(shared.personal).toBeUndefined();
    expect(mine.personal).toBe(true);
  });

  it("declines a package with no oauth2 step rather than inventing one", () => {
    const bare = { ...manifest(), auth: { ...manifest().auth, steps: [] } } as OimManifest;
    expect(oimOAuthLegacyManifest(bare)).toBeUndefined();
  });
});

describe("oimCredentialsFromEnv", () => {
  it("routes each env value back to its slot and lifts the expiry off the credentials", () => {
    const result = oimCredentialsFromEnv(manifest(), {
      [oimSlotEnv("access_token")]: "at",
      [oimSlotEnv("refresh_token")]: "rt",
      [oimSlotEnv("workspace_id")]: "w_1",
      [`${oimSlotEnv("access_token")}_EXPIRES_AT`]: "2030-01-01T00:00:00.000Z",
    });

    expect(result.slots).toEqual({ access_token: "at", refresh_token: "rt", workspace_id: "w_1" });
    expect(result.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("leaves the expiry null when the provider issues a token that does not lapse", () => {
    const result = oimCredentialsFromEnv(manifest(), { [oimSlotEnv("access_token")]: "at" });
    expect(result.expiresAt).toBeNull();
  });
});

describe("refreshOimOAuthStep", () => {
  it("uses the declared step and returns only its provider-issued credential bindings", async () => {
    const source = manifest();
    const step = source.auth?.steps[0];
    if (step?.type !== "oauth2") throw new Error("expected an oauth2 step");
    const connection = {
      integration: { id: "acme", majorVersion: 1 },
      configuration: {},
    } as PersistedConnection;

    const result = await refreshOimOAuthStep(
      {
        manifest: source,
        step,
        connection,
        credentials: {
          client_id: "client",
          client_secret: "secret",
          refresh_token: "refresh",
          unrelated: "must-not-leak",
        },
      },
      {
        now: new Date("2026-09-12T12:00:00.000Z"),
        verifyIdentity: async () => ({
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "a".repeat(64),
          verifiedAt: "2026-09-12T12:00:00.000Z",
          verifiedBy: "provider-profile",
        }),
        fetchImpl: async (_url, init) => {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("client");
          expect(body.get("client_secret")).toBe("secret");
          expect(body.get("refresh_token")).toBe("refresh");
          expect(String(init?.body)).not.toContain("must-not-leak");
          return new Response(
            JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
              workspace: { id: "workspace-1" },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
      }
    );

    expect(result).toEqual({
      credentialValues: {
        access_token: "new-access",
        refresh_token: "new-refresh",
        workspace_id: "workspace-1",
      },
      expiresAt: "2026-09-12T13:00:00.000Z",
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        proofDigest: "a".repeat(64),
        verifiedAt: "2026-09-12T12:00:00.000Z",
        verifiedBy: "provider-profile",
      },
    });
  });
});

describe("oimAuthLegacyManifest", () => {
  it("preserves multi-step app creation, installation, and OAuth order", () => {
    const source = manifest();
    const auth = source.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    const flow = oimAuthLegacyManifest({
      ...source,
      auth: {
        ...auth,
        configurationFields: [
          { id: "site", label: "Site", type: "string", required: true, agentVisible: true },
        ],
        steps: [
          {
            id: "app",
            title: "Create app",
            type: "app_manifest",
            createUrl: "https://acme.test/apps/new",
            manifest: { callback_url: "{callback_url}", state: "{state}" },
            bindings: [
              { sourcePath: "/client_id", target: { type: "credential", slot: "client_id" } },
            ],
          },
          {
            id: "install",
            title: "Install app",
            type: "install",
            url: "https://acme.test/install?state={state}",
            bindings: [{ sourcePath: "/site", target: { type: "configuration", field: "site" } }],
          },
          auth.steps[0],
        ],
      },
    });

    expect(flow.auth?.map((step) => step.kind)).toEqual(["app_manifest", "install", "oauth2"]);
    expect(oimLegacyStepIndex(flow, "install")).toBe(1);
    expect(flow.auth?.[1]).toMatchObject({
      kind: "install",
      url: "https://acme.test/install?state={state}",
    });
  });

  it("appends a raw state template when an install URL omits one", () => {
    const source = manifest();
    const auth = source.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    const flow = oimAuthLegacyManifest({
      ...source,
      auth: {
        ...auth,
        steps: [
          {
            id: "install",
            title: "Install app",
            type: "install",
            url: "https://acme.test/install",
            bindings: [],
          },
        ],
      },
    });

    expect(flow.auth?.[0]).toMatchObject({
      kind: "install",
      url: "https://acme.test/install?state={state}",
    });
  });

  it("replaces encoded or provider-supplied state with the host-owned raw template", () => {
    for (const state of ["%7Bstate%7D", "provider-value"]) {
      const source = manifest();
      const auth = source.auth;
      if (auth === undefined) throw new Error("fixture has auth");
      const flow = oimAuthLegacyManifest({
        ...source,
        auth: {
          ...auth,
          steps: [
            {
              id: "install",
              title: "Install app",
              type: "install",
              url: `https://acme.test/install?next=home&state=${state}#done`,
              bindings: [],
            },
          ],
        },
      });

      expect(flow.auth?.[0]).toMatchObject({
        kind: "install",
        url: "https://acme.test/install?next=home&state={state}#done",
      });
    }
  });

  it("maps callback outputs into credential and configuration planes", () => {
    const source = manifest();
    const auth = source.auth;
    if (auth === undefined) throw new Error("fixture has auth");
    const withConfig = {
      ...source,
      auth: {
        ...auth,
        configurationFields: [
          { id: "site", label: "Site", type: "string", required: true, agentVisible: true },
        ],
        steps: [
          {
            id: "install",
            title: "Install",
            type: "install",
            url: "https://acme.test/install?state={state}",
            bindings: [
              { sourcePath: "/token", target: { type: "credential", slot: "access_token" } },
              { sourcePath: "/site", target: { type: "configuration", field: "site" } },
            ],
          },
        ],
      },
    } as OimManifest;

    expect(
      oimConnectionPatchFromEnv(withConfig, {
        [oimSlotEnv("access_token")]: "token",
        OIM_CONFIG_SITE: "tenant.acme.test",
      })
    ).toEqual({
      slots: { access_token: "token" },
      configuration: { site: "tenant.acme.test" },
      expiresAt: null,
    });
  });
});
