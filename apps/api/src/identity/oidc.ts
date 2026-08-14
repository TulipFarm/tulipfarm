import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "../db";

/** OIDC requests are server-side, one-use, and keep state, nonce, and PKCE verifier off-browser. */

export interface OidcClaims {
  /** Stable provider-scoped subject identifier. Never an email — emails are re-assignable. */
  readonly subject: string;
  readonly email?: string;
  /** Authentication methods the provider asserts, e.g. `["pwd", "mfa"]`. */
  readonly amr?: readonly string[];
}

export interface OidcAuthorizationParams {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface OidcExchangeParams {
  readonly code: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
}

export interface OidcProvider {
  readonly providerId: string;
  authorizationUrl(params: OidcAuthorizationParams): string;
  /** Verifies the code and the id-token nonce, returning claims. Throws on any invalid token. */
  exchange(params: OidcExchangeParams): Promise<OidcClaims>;
}

export interface OidcAuthRequestDoc {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectTo: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface OidcAuthRequestRepo {
  create(request: OidcAuthRequestDoc): Promise<void>;
  /** Atomically consumes the request; returns null when unknown, expired, or already consumed. */
  consume(state: string): Promise<OidcAuthRequestDoc | null>;
}

export const DEFAULT_OIDC_REQUEST_TTL_SECONDS = 600;

function rowToRequest(row: Record<string, unknown>): OidcAuthRequestDoc {
  return {
    state: row.state as string,
    nonce: row.nonce as string,
    codeVerifier: row.code_verifier as string,
    redirectTo: (row.redirect_to as string | null) ?? null,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    consumedAt: (row.consumed_at as Date | null) ?? null,
  };
}

export class PgOidcAuthRequestRepo implements OidcAuthRequestRepo {
  constructor(private readonly q: Queryable) {}

  async create(request: OidcAuthRequestDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO oidc_auth_requests (state, nonce, code_verifier, redirect_to, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        request.state,
        request.nonce,
        request.codeVerifier,
        request.redirectTo,
        request.createdAt,
        request.expiresAt,
        request.consumedAt,
      ]
    );
  }

  async consume(state: string): Promise<OidcAuthRequestDoc | null> {
    const { rows } = await this.q.query(
      `UPDATE oidc_auth_requests SET consumed_at = now()
       WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [state]
    );
    return rows.length > 0 ? rowToRequest(rows[0]) : null;
  }
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function deriveCodeChallenge(codeVerifier: string): string {
  return base64UrlSha256(codeVerifier);
}

/** Creates and persists a one-use authorization request, returning the provider redirect URL. */
export async function startOidcAuthorization(
  repo: OidcAuthRequestRepo,
  provider: OidcProvider,
  input: { redirectUri: string; redirectTo?: string | null; ttlSeconds?: number }
): Promise<{ url: string; state: string }> {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const now = new Date();
  await repo.create({
    state,
    nonce,
    codeVerifier,
    redirectTo: input.redirectTo ?? null,
    createdAt: now,
    expiresAt: new Date(
      now.getTime() + (input.ttlSeconds ?? DEFAULT_OIDC_REQUEST_TTL_SECONDS) * 1000
    ),
    consumedAt: null,
  });
  const url = provider.authorizationUrl({
    state,
    nonce,
    codeChallenge: deriveCodeChallenge(codeVerifier),
    redirectUri: input.redirectUri,
  });
  return { url, state };
}

export type OidcDenialReason = "invalid_state" | "exchange_failed";

export class OidcDeniedError extends Error {
  constructor(
    public readonly reason: OidcDenialReason,
    message: string
  ) {
    super(message);
    this.name = "OidcDeniedError";
  }
}

/** Consume the one-use request, then exchange with stored PKCE/nonce; echo no provider errors. */
export async function completeOidcAuthorization(
  repo: OidcAuthRequestRepo,
  provider: OidcProvider,
  input: { state: string; code: string; redirectUri: string }
): Promise<{ claims: OidcClaims; redirectTo: string | null }> {
  const request = await repo.consume(input.state);
  if (!request) {
    throw new OidcDeniedError(
      "invalid_state",
      "authorization request is unknown, used, or expired"
    );
  }
  try {
    const claims = await provider.exchange({
      code: input.code,
      codeVerifier: request.codeVerifier,
      nonce: request.nonce,
      redirectUri: input.redirectUri,
    });
    return { claims, redirectTo: request.redirectTo };
  } catch {
    throw new OidcDeniedError("exchange_failed", "authorization code exchange failed");
  }
}

/** Provider `amr` values that prove a second factor was used at the identity provider. */
const MFA_AMR_VALUES = new Set(["mfa", "otp", "hwk", "swk", "face", "fpt", "pin", "sc"]);

export function claimsProveMfa(claims: OidcClaims): boolean {
  return (claims.amr ?? []).some((value) => MFA_AMR_VALUES.has(value));
}
