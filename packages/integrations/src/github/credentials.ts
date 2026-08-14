import { createSign } from "node:crypto";
import type { IntegrationHttpPort } from "../http";

/** Pure GitHub App JWT/token minting; secrets and token caching stay in the caller. */

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

/** Sign a GitHub App JWT (RS256, `iss` = App ID). */
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

/** Exchange an App JWT for a short-lived installation token scoped by the installation. */
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

/** Context resolved fresh on cache miss because this package cannot read secrets. */
export interface InstallationTokenMintContext {
  readonly appExternalId: string;
  readonly installationId: string;
  readonly privateKeyPem: string;
}

export interface CachingInstallationTokenMinterDeps {
  readonly http: IntegrationHttpPort;
  /** Resolves mint context, or `undefined` when no active config exists. */
  readonly resolveContext: () => Promise<InstallationTokenMintContext | undefined>;
  readonly now?: () => Date;
}

/** Cache tokens until refresh margin; failures return `undefined`, never stale data. */
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
