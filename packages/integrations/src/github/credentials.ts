import { createSign } from "node:crypto";
import type { IntegrationHttpPort } from "../http";

/**
 * GitHub App credential minting: App JWT signing and installation-access-token exchange.
 *
 * Deliberately has no dependency on `@tulipfarm/secrets` — this package may not import it (see
 * `docs/architecture/dependency-rules.md`). These are pure functions over an `IntegrationHttpPort`;
 * the composing application (which imports both `@tulipfarm/integrations` and
 * `@tulipfarm/secrets`) is responsible for reading the App's stored id/private key/webhook secret
 * and wrapping `mintInstallationToken` behind a caching `SecretProvider`.
 *
 * Nothing here caches. A fresh App JWT is minted per exchange call; the installation token itself
 * is never persisted, logged, or retained by this module — the caller owns its lifetime.
 */

export type GitHubCredentialErrorReason =
  | "invalid_private_key"
  | "installation_not_found"
  | "token_exchange_failed";

export class GitHubCredentialError extends Error {
  readonly name = "GitHubCredentialError";

  constructor(readonly reason: GitHubCredentialErrorReason) {
    super(`github_credential_error:${reason}`);
  }
}

const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_TTL_SECONDS = 9 * 60; // GitHub caps App JWT exp at 10 minutes; stay under with margin.

function base64url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input) : input;
  return buffer.toString("base64url");
}

/**
 * Sign a GitHub App JWT (RS256, `iss` = App ID). `now` is injected for deterministic tests.
 */
export function signAppJwt(
  appId: string,
  privateKeyPem: string,
  now: () => Date = () => new Date()
): string {
  const issuedAt = Math.floor(now().getTime() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: issuedAt - JWT_CLOCK_SKEW_SECONDS,
    exp: issuedAt + JWT_TTL_SECONDS,
    iss: appId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  let signature: Buffer;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(privateKeyPem);
  } catch {
    throw new GitHubCredentialError("invalid_private_key");
  }

  return `${signingInput}.${base64url(signature)}`;
}

export interface MintedInstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Exchange an App JWT for a short-lived (~1hr) installation access token, scoped to whatever
 * repositories/permissions the installation grants. Returns null (never a stale/guessed value) on
 * any non-2xx — the caller decides how to surface that as a denied credential lease.
 */
export async function mintInstallationToken(
  http: IntegrationHttpPort,
  appJwt: string,
  installationId: string
): Promise<MintedInstallationToken> {
  const response = await http.send(
    {
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      headers: { "x-github-api-version": "2022-11-28" },
    },
    appJwt
  );

  if (response.status === 404) {
    throw new GitHubCredentialError("installation_not_found");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new GitHubCredentialError("token_exchange_failed");
  }

  const body = response.body as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new GitHubCredentialError("token_exchange_failed");
  }

  return { token: body.token, expiresAt: new Date(body.expires_at) };
}

/** Refresh ahead of GitHub's ~1hr expiry so a lease never redeems an about-to-expire token. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedInstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** What `createCachingInstallationTokenMinter` needs to sign a fresh App JWT and exchange it —
 * resolved fresh on every cache miss, since the private key is a `SecretsService` read this
 * package may not perform itself (see module doc). */
export interface InstallationTokenMintContext {
  readonly appExternalId: string;
  readonly installationId: string;
  readonly privateKeyPem: string;
}

export interface CachingInstallationTokenMinterDeps {
  readonly http: IntegrationHttpPort;
  /** Resolves the App/installation/key to mint against, or `undefined` when nothing is
   * configured/active — the caller's own lookup (App config, installation directory, secrets). */
  readonly resolveContext: () => Promise<InstallationTokenMintContext | undefined>;
  readonly now?: () => Date;
}

/**
 * The caching "sign a fresh App JWT, exchange it for an installation token, keep the token until
 * it's due to expire" sequence that both `apps/api` (soul repo credentials) and `apps/worker`
 * (Tool-dispatch credentials) need identically — only *what* they resolve the mint context from
 * differs (a named installation vs. "the business's one active installation"), which is why that
 * part stays a caller-supplied `resolveContext`. Fails closed: `undefined` on any unconfigured
 * state or minting failure, never a stale or guessed token.
 */
export function createCachingInstallationTokenMinter(
  deps: CachingInstallationTokenMinterDeps
): () => Promise<string | undefined> {
  const now = deps.now ?? (() => new Date());
  let cached: CachedInstallationToken | undefined;

  return async () => {
    if (
      cached !== undefined &&
      cached.expiresAt.getTime() - TOKEN_REFRESH_MARGIN_MS > now().getTime()
    ) {
      return cached.token;
    }

    const context = await deps.resolveContext();
    if (context === undefined) return undefined;

    try {
      const appJwt = signAppJwt(context.appExternalId, context.privateKeyPem, now);
      const minted = await mintInstallationToken(deps.http, appJwt, context.installationId);
      cached = { token: minted.token, expiresAt: minted.expiresAt };
      return minted.token;
    } catch (error) {
      if (error instanceof GitHubCredentialError) return undefined;
      throw error;
    }
  };
}
