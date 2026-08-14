import type { IntegrationManifest, SoulIntegration, SoulLoader } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  InMemoryPrincipalProviderTokenRepo,
  type PrincipalProviderTokenDoc,
} from "../integrations/principal-tokens";
import { CredentialResolver, providerSupportsPersonalCredential } from "./credential-mode";

function integration(auth: IntegrationManifest["auth"]): SoulIntegration {
  return {
    slug: "acme",
    sourceIntegration: "acme",
    manifest: { name: "acme", version: "1.0.0", ...(auth === undefined ? {} : { auth }) },
  } as SoulIntegration;
}

function connected(
  principal: { kind: string; id: string },
  provider: string
): PrincipalProviderTokenDoc {
  return {
    principalKind: principal.kind,
    principalId: principal.id,
    provider,
    secretKey: `principal.${principal.kind}.${principal.id}.${provider}.TOKEN`,
    refreshSecretKey: null,
    externalSubject: null,
    scopes: [],
    connectedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    revokedAt: null,
  };
}

const human = { kind: "user", id: "u1" };
const routine = { kind: "routine", id: "r1" };

function resolverFor(
  entries: readonly SoulIntegration[],
  tokens = new InMemoryPrincipalProviderTokenRepo()
) {
  // Narrow fake: credential mode only reads one loader map.
  const soulLoader = {
    integrations: new Map(entries.map((i) => [i.slug, i])),
  } as unknown as SoulLoader;
  return new CredentialResolver({ tokens, soulLoader });
}

describe("providerSupportsPersonalCredential", () => {
  it("is true for an authorization-code oauth2 step that declares itself personal", () => {
    expect(
      providerSupportsPersonalCredential(
        integration([
          { id: "connect", kind: "oauth2", grant: "authorization_code", personal: true },
        ] as never)
      )
    ).toBe(true);
  });

  it("defaults a grant-less personal oauth2 step to authorization_code", () => {
    expect(
      providerSupportsPersonalCredential(
        integration([{ id: "connect", kind: "oauth2", personal: true }] as never)
      )
    ).toBe(true);
  });

  /** Slack uses a team-level OAuth step; grant type is not a credential-mode discriminator. */
  it("is false for an authorization_code step that does not declare itself personal", () => {
    expect(
      providerSupportsPersonalCredential(
        integration([{ id: "install", kind: "oauth2", grant: "authorization_code" }] as never)
      )
    ).toBe(false);
  });

  /** Legacy manifests may declare only deprecated `oauth`; classification must not throw. */
  it("reads through resolveAuthSteps rather than manifest.auth, so a legacy block is not misread", () => {
    const legacy = {
      slug: "legacy",
      manifest: {
        oauth: {
          flows: {
            authorizationCode: {
              authorizationUrl: "https://p.example/authorize",
              tokenUrl: "https://p.example/token",
              scopes: { read: "read" },
            },
          },
          "x-tulipfarm": {
            client_id_env: "C_ID",
            client_secret_env: "C_SECRET",
            token_env: "TOKEN",
          },
        },
      },
    } as unknown as SoulIntegration;
    expect(providerSupportsPersonalCredential(legacy)).toBe(false);
  });

  it("is false for client_credentials, which mints a bot credential and not a personal one", () => {
    expect(
      providerSupportsPersonalCredential(
        integration([{ id: "connect", kind: "oauth2", grant: "client_credentials" }] as never)
      )
    ).toBe(false);
  });

  it("is false for a GitHub-shaped app_manifest install with no oauth2 step at all", () => {
    expect(
      providerSupportsPersonalCredential(
        integration([
          { id: "app", kind: "app_manifest" },
          { id: "install", kind: "install" },
        ] as never)
      )
    ).toBe(false);
  });
});

describe("CredentialResolver", () => {
  const oauthProvider = integration([
    { id: "connect", kind: "oauth2", grant: "authorization_code", personal: true },
  ] as never);
  const installProvider = integration([{ id: "install", kind: "install" }] as never);

  it("spends the service credential when a Tool names no provider", async () => {
    const r = resolverFor([]);
    expect(await r.resolve(human, { name: "record_create", credentialMode: "service" })).toEqual({
      use: "service",
    });
  });

  it("spends the service credential for a service-mode provider Tool even for a human", async () => {
    const r = resolverFor([oauthProvider]);
    expect(
      await r.resolve(human, { name: "slack_post", provider: "acme", credentialMode: "service" })
    ).toEqual({ use: "service" });
  });

  it("spends the person's own credential once they have connected", async () => {
    const tokens = new InMemoryPrincipalProviderTokenRepo();
    await tokens.upsert(connected(human, "acme"));
    const r = resolverFor([oauthProvider], tokens);
    expect(
      await r.resolve(human, { name: "acme_search", provider: "acme", credentialMode: "user" })
    ).toEqual({ use: "principal", principal: human });
  });

  it("refuses a strict user-mode call from a human who has not connected", async () => {
    const r = resolverFor([oauthProvider]);
    const result = await r.resolve(human, {
      name: "acme_search",
      provider: "acme",
      credentialMode: "user",
    });
    expect(result.use).toBe("denied");
    // The refusal has to tell them how to fix it, or the model retries a call that cannot succeed.
    expect(result.use === "denied" && result.reason).toContain("connect");
  });

  it("refuses rather than downgrading under user_preferred when the provider can issue one", async () => {
    // `preferred` must not silently fall back to the bot for unconnected users.
    const r = resolverFor([oauthProvider]);
    expect(
      (
        await r.resolve(human, {
          name: "acme_search",
          provider: "acme",
          credentialMode: "user_preferred",
        })
      ).use
    ).toBe("denied");
  });

  it("falls back to service under user_preferred when the provider cannot issue a personal credential", async () => {
    // GitHub today. Refusing here would deny the Tool forever with no way for anyone to recover.
    const r = resolverFor([installProvider]);
    expect(
      await r.resolve(human, {
        name: "github_create_issue",
        provider: "acme",
        credentialMode: "user_preferred",
      })
    ).toEqual({ use: "service" });
  });

  it("falls back to service under user_preferred when the provider is not in the catalog", async () => {
    const r = resolverFor([]);
    expect(
      await r.resolve(human, {
        name: "acme_search",
        provider: "acme",
        credentialMode: "user_preferred",
      })
    ).toEqual({ use: "service" });
  });

  it("spends the service credential for unattended user_preferred work", async () => {
    const r = resolverFor([oauthProvider]);
    expect(
      await r.resolve(routine, {
        name: "acme_search",
        provider: "acme",
        credentialMode: "user_preferred",
      })
    ).toEqual({ use: "service" });
  });

  it("refuses unattended strict user-mode work outright", async () => {
    const r = resolverFor([oauthProvider]);
    const result = await r.resolve(routine, {
      name: "acme_search",
      provider: "acme",
      credentialMode: "user",
    });
    expect(result.use).toBe("denied");
  });

  it("stops spending a personal credential the moment it is revoked", async () => {
    const tokens = new InMemoryPrincipalProviderTokenRepo();
    await tokens.upsert(connected(human, "acme"));
    await tokens.revoke(human, "acme");
    const r = resolverFor([oauthProvider], tokens);
    expect(
      (await r.resolve(human, { name: "t", provider: "acme", credentialMode: "user" })).use
    ).toBe("denied");
  });

  it("does not let one person's connection authorize another's call", async () => {
    const tokens = new InMemoryPrincipalProviderTokenRepo();
    await tokens.upsert(connected(human, "acme"));
    const r = resolverFor([oauthProvider], tokens);
    expect(
      (
        await r.resolve(
          { kind: "user", id: "u2" },
          { name: "t", provider: "acme", credentialMode: "user" }
        )
      ).use
    ).toBe("denied");
  });

  it("does not let a connection for one provider authorize a call to another", async () => {
    const tokens = new InMemoryPrincipalProviderTokenRepo();
    await tokens.upsert(connected(human, "other"));
    const r = resolverFor([oauthProvider], tokens);
    expect(
      (await r.resolve(human, { name: "t", provider: "acme", credentialMode: "user" })).use
    ).toBe("denied");
  });
});
