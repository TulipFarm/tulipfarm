import { createSign } from "node:crypto";
import type { EgressHttpPort } from "../egress/openapi-adapter";

const DEFAULT_TTL_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;

export interface JwtAssertionClaims {
  readonly issuer: string;
  readonly subject?: string;
  readonly audience?: string;
  readonly scopes?: readonly string[];
}

export interface JwtAssertionExchange {
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly expiresAt: string | null;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function signRs256Assertion(
  claims: JwtAssertionClaims,
  privateKeyPem: string,
  options: { readonly now?: Date; readonly ttlSeconds?: number } = {}
): string {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (ttlSeconds < 60 || ttlSeconds > 600) throw new Error("jwt_assertion_ttl_invalid");

  const payload = {
    iss: claims.issuer,
    ...(claims.subject === undefined ? {} : { sub: claims.subject }),
    ...(claims.audience === undefined ? {} : { aud: claims.audience }),
    ...(claims.scopes === undefined ? {} : { scope: claims.scopes.join(" ") }),
    iat: now - CLOCK_SKEW_SECONDS,
    exp: now + ttlSeconds,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(payload)
  )}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${base64url(signer.sign(privateKeyPem))}`;
  } catch {
    throw new Error("jwt_assertion_private_key_invalid");
  }
}

export async function exchangeOAuthJwtBearer(
  http: EgressHttpPort,
  tokenUrl: string,
  assertion: string,
  now: Date
): Promise<JwtAssertionExchange> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const response = await http.send({
    url: tokenUrl,
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    bodyText: body.toString(),
    maxResponseBytes: 64 * 1_024,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("jwt_assertion_exchange_failed");
  }
  return tokenResponse(response.body, now);
}

export async function exchangeGitHubAppJwt(
  http: EgressHttpPort,
  tokenUrl: string,
  assertion: string
): Promise<JwtAssertionExchange> {
  const response = await http.send({
    url: tokenUrl,
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${assertion}`,
      "x-github-api-version": "2022-11-28",
    },
    maxResponseBytes: 64 * 1_024,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("jwt_assertion_exchange_failed");
  }
  const body = response.body as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new Error("jwt_assertion_exchange_invalid");
  }
  const expiresAt = new Date(body.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("jwt_assertion_exchange_invalid");
  return { credentialValues: { access_token: body.token }, expiresAt: expiresAt.toISOString() };
}

function tokenResponse(body: unknown, now: Date): JwtAssertionExchange {
  const value = body as {
    access_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  };
  if (typeof value.access_token !== "string") throw new Error("jwt_assertion_exchange_invalid");
  const expiresIn =
    typeof value.expires_in === "number"
      ? value.expires_in
      : typeof value.expires_in === "string"
        ? Number(value.expires_in)
        : undefined;
  const expiresAt =
    expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(now.getTime() + expiresIn * 1_000).toISOString()
      : null;
  return { credentialValues: { access_token: value.access_token }, expiresAt };
}
