import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl } from "./auth-broker";
import {
  OIM_OAUTH_STEP_INDEX,
  oimCredentialsFromEnv,
  oimOAuthLegacyManifest,
  oimSlotEnv,
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

  it("keeps every non-token binding, so a workspace id survives the exchange", () => {
    const step = oimOAuthLegacyManifest(manifest())?.auth?.[OIM_OAUTH_STEP_INDEX];
    if (step?.kind !== "oauth2") throw new Error("expected an oauth2 step");
    expect(step.map).toEqual({ "workspace.id": oimSlotEnv("workspace_id") });
    expect(step.refresh_token_env).toBe(oimSlotEnv("refresh_token"));
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
