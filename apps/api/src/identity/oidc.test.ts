import { describe, expect, it, vi } from "vitest";
import { MemoryOidcRequestRepo } from "./fakes";
import {
  claimsProveMfa,
  completeOidcAuthorization,
  deriveCodeChallenge,
  type OidcAuthRequestDoc,
  type OidcAuthRequestRepo,
  OidcDeniedError,
  type OidcExchangeParams,
  type OidcProvider,
  startOidcAuthorization,
} from "./oidc";

function makeProvider(exchange?: (params: OidcExchangeParams) => Promise<unknown>): OidcProvider {
  return {
    providerId: "acme-oidc",
    authorizationUrl: ({ state, nonce, codeChallenge, redirectUri }) =>
      `https://idp.example/authorize?state=${state}&nonce=${nonce}&code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchange: (exchange ?? (async () => ({ subject: "sub-1" }))) as OidcProvider["exchange"],
  };
}

const REDIRECT_URI = "https://app.example/api/v1/auth/oidc/callback";

describe("startOidcAuthorization", () => {
  it("persists a one-use request and returns the provider url with a PKCE challenge", async () => {
    const repo = new MemoryOidcRequestRepo();
    const { url, state } = await startOidcAuthorization(repo, makeProvider(), {
      redirectUri: REDIRECT_URI,
    });

    const stored = repo.requests[0];
    expect(stored.state).toBe(state);
    expect(stored.consumedAt).toBeNull();
    expect(url).toContain(`code_challenge=${deriveCodeChallenge(stored.codeVerifier)}`);
    // The verifier itself must never leave the server.
    expect(url).not.toContain(stored.codeVerifier);
  });

  it("issues a distinct state and nonce per request", async () => {
    const repo = new MemoryOidcRequestRepo();
    await startOidcAuthorization(repo, makeProvider(), { redirectUri: REDIRECT_URI });
    await startOidcAuthorization(repo, makeProvider(), { redirectUri: REDIRECT_URI });

    expect(repo.requests[0].state).not.toBe(repo.requests[1].state);
    expect(repo.requests[0].nonce).not.toBe(repo.requests[1].nonce);
  });
});

describe("completeOidcAuthorization", () => {
  it("exchanges the code with the stored verifier and nonce", async () => {
    const repo = new MemoryOidcRequestRepo();
    const exchange = vi.fn(async () => ({ subject: "sub-1", email: "a@example.com" }));
    const provider = makeProvider(exchange);
    const { state } = await startOidcAuthorization(repo, provider, { redirectUri: REDIRECT_URI });
    const stored = repo.requests[0];

    const result = await completeOidcAuthorization(repo, provider, {
      state,
      code: "code-1",
      redirectUri: REDIRECT_URI,
    });

    expect(result.claims.subject).toBe("sub-1");
    expect(exchange).toHaveBeenCalledWith({
      code: "code-1",
      codeVerifier: stored.codeVerifier,
      nonce: stored.nonce,
      redirectUri: REDIRECT_URI,
    });
  });

  it("denies a replayed state", async () => {
    const repo = new MemoryOidcRequestRepo();
    const provider = makeProvider();
    const { state } = await startOidcAuthorization(repo, provider, { redirectUri: REDIRECT_URI });

    await completeOidcAuthorization(repo, provider, {
      state,
      code: "code-1",
      redirectUri: REDIRECT_URI,
    });

    await expect(
      completeOidcAuthorization(repo, provider, {
        state,
        code: "code-1",
        redirectUri: REDIRECT_URI,
      })
    ).rejects.toMatchObject({ reason: "invalid_state" });
  });

  it("denies an unknown state", async () => {
    const repo = new MemoryOidcRequestRepo();

    await expect(
      completeOidcAuthorization(repo, makeProvider(), {
        state: "forged",
        code: "code-1",
        redirectUri: REDIRECT_URI,
      })
    ).rejects.toBeInstanceOf(OidcDeniedError);
  });

  it("denies an expired state", async () => {
    const repo = new MemoryOidcRequestRepo();
    const provider = makeProvider();
    const { state } = await startOidcAuthorization(repo, provider, {
      redirectUri: REDIRECT_URI,
      ttlSeconds: -1,
    });

    await expect(
      completeOidcAuthorization(repo, provider, {
        state,
        code: "code-1",
        redirectUri: REDIRECT_URI,
      })
    ).rejects.toMatchObject({ reason: "invalid_state" });
  });

  it("does not leak provider error detail when the exchange fails", async () => {
    const repo = new MemoryOidcRequestRepo();
    const provider = makeProvider(async () => {
      throw new Error("client_secret nBk3f2 rejected by https://idp.example/token");
    });
    const { state } = await startOidcAuthorization(repo, provider, { redirectUri: REDIRECT_URI });

    const error = await completeOidcAuthorization(repo, provider, {
      state,
      code: "code-1",
      redirectUri: REDIRECT_URI,
    }).then(
      () => null,
      (e: unknown) => e as OidcDeniedError
    );

    expect(error).toBeInstanceOf(OidcDeniedError);
    expect(error?.message).not.toContain("nBk3f2");
    expect(error?.reason).toBe("exchange_failed");
  });

  it("consumes the state even when the exchange fails, so the code cannot be retried", async () => {
    const repo = new MemoryOidcRequestRepo();
    const provider = makeProvider(async () => {
      throw new Error("boom");
    });
    const { state } = await startOidcAuthorization(repo, provider, { redirectUri: REDIRECT_URI });

    await completeOidcAuthorization(repo, provider, {
      state,
      code: "c",
      redirectUri: REDIRECT_URI,
    }).catch(() => undefined);

    expect(repo.requests[0].consumedAt).not.toBeNull();
  });
});

describe("claimsProveMfa", () => {
  it("is true only when the provider asserts a second factor", () => {
    expect(claimsProveMfa({ subject: "s", amr: ["pwd"] })).toBe(false);
    expect(claimsProveMfa({ subject: "s" })).toBe(false);
    expect(claimsProveMfa({ subject: "s", amr: ["pwd", "mfa"] })).toBe(true);
    expect(claimsProveMfa({ subject: "s", amr: ["hwk"] })).toBe(true);
  });
});
