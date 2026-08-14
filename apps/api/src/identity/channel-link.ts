import { createHash, randomBytes } from "node:crypto";
import type {
  ChannelBindTokenDoc,
  ExternalIdentityMappingDoc,
  ExternalIdentityRepo,
} from "./external-links";
import {
  resolveSigningKey,
  type SigningKeyStore,
  signingKeyResolver,
  signToken,
  verifyToken,
} from "./signed-token";

/** Channel bind links carry only `{slug, senderId, issuedAt, nonce}` under HMAC. */

/** Where the HMAC key lives. Held in the secret store, never a constant compiled into the build. */
export const CHANNEL_BIND_SIGNING_KEY = "channel-bind.signing-key";

export const CHANNEL_BIND_TTL_MS = 15 * 60_000;

/** Just enough of `SecretsService` to hold one key, so callers need not carry the whole service. */
export type ChannelBindKeyStore = SigningKeyStore;

/** Provision the HMAC key only after `list`; an unreachable store must not rotate it. */
export async function resolveChannelBindKey(secrets: ChannelBindKeyStore): Promise<Buffer> {
  return resolveSigningKey(secrets, CHANNEL_BIND_SIGNING_KEY);
}

/** Memoizes the key for the process; bind links do not outlive boot by design. */
export function channelBindKeyResolver(secrets: ChannelBindKeyStore): () => Promise<Buffer> {
  return signingKeyResolver(secrets, CHANNEL_BIND_SIGNING_KEY);
}

/** What the link asserts. Deliberately no user id — at issue time no account is known. */
export interface ChannelBindClaims {
  slug: string;
  senderId: string;
  issuedAt: number;
  nonce: string;
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function isChannelBindClaims(claims: unknown): claims is ChannelBindClaims {
  if (typeof claims !== "object" || claims === null) return false;
  const { slug, senderId, issuedAt, nonce } = claims as Record<string, unknown>;
  return (
    typeof slug === "string" &&
    typeof senderId === "string" &&
    typeof issuedAt === "number" &&
    typeof nonce === "string"
  );
}

/** Verify claims with constant-time signature comparison; return null for malformed input. */
export function parseChannelBindToken(key: Buffer, token: string): ChannelBindClaims | null {
  const claims = verifyToken<ChannelBindClaims>(key, token);
  return claims !== null && isChannelBindClaims(claims) ? claims : null;
}

export type ChannelBindDenialReason = "invalid_token";

/** Coarse rejection reason; never reveal forged vs expired vs spent. */
export class ChannelBindDeniedError extends Error {
  constructor(
    public readonly reason: ChannelBindDenialReason,
    message: string
  ) {
    super(message);
    this.name = "ChannelBindDeniedError";
  }
}

export interface ChannelBindDeps {
  repo: ExternalIdentityRepo;
  signingKey: () => Promise<Buffer>;
  now?: () => Date;
  ttlMs?: number;
}

export interface IssuedChannelBind {
  token: string;
  expiresAt: Date;
}

/** Channel identity the confirmation page names before the person claims it. */
export interface ChannelBindOffer {
  slug: string;
  senderId: string;
  expiresAt: Date;
}

/** Write the nonce before returning the token so every token has a row to spend. */
export async function issueChannelBindToken(
  deps: ChannelBindDeps,
  input: { slug: string; senderId: string }
): Promise<IssuedChannelBind> {
  const now = (deps.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + (deps.ttlMs ?? CHANNEL_BIND_TTL_MS));
  const nonce = randomBytes(32).toString("base64url");

  await deps.repo.createBindToken({
    nonceHash: hashNonce(nonce),
    integrationSlug: input.slug,
    externalSenderId: input.senderId,
    issuedAt: now,
    expiresAt,
    consumedAt: null,
    consumedBy: null,
  });

  const claims: ChannelBindClaims = {
    slug: input.slug,
    senderId: input.senderId,
    issuedAt: now.getTime(),
    nonce,
  };
  return { token: signToken(await deps.signingKey(), claims), expiresAt };
}

/** Preview checks redemption constraints without spending the nonce. */
async function openOffer(
  deps: ChannelBindDeps,
  token: string
): Promise<{ claims: ChannelBindClaims; row: ChannelBindTokenDoc }> {
  const claims = parseChannelBindToken(await deps.signingKey(), token);
  if (!claims) {
    throw new ChannelBindDeniedError(
      "invalid_token",
      "bind token is not signed by this deployment"
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  // Enforce expiry from both signed claims and the row.
  if (now.getTime() - claims.issuedAt >= (deps.ttlMs ?? CHANNEL_BIND_TTL_MS)) {
    throw new ChannelBindDeniedError("invalid_token", "bind token is no longer valid");
  }
  const row = await deps.repo.findBindToken(hashNonce(claims.nonce));
  if (!row || row.expiresAt <= now) {
    throw new ChannelBindDeniedError("invalid_token", "bind token is no longer valid");
  }
  if (row.integrationSlug !== claims.slug || row.externalSenderId !== claims.senderId) {
    throw new ChannelBindDeniedError("invalid_token", "bind token does not match its offer");
  }
  return { claims, row };
}

export async function previewChannelBind(
  deps: ChannelBindDeps,
  token: string
): Promise<ChannelBindOffer> {
  const { claims, row } = await openOffer(deps, token);
  return { slug: claims.slug, senderId: claims.senderId, expiresAt: row.expiresAt };
}

/** Spend the nonce before writing the mapping so concurrent clicks cannot bind twice. */
export async function redeemChannelBindToken(
  deps: ChannelBindDeps,
  token: string,
  userId: string
): Promise<ExternalIdentityMappingDoc> {
  const { claims } = await openOffer(deps, token);
  const spent = await deps.repo.consumeBindToken(hashNonce(claims.nonce), userId);
  if (!spent) {
    throw new ChannelBindDeniedError("invalid_token", "bind token is no longer valid");
  }
  const mapping: ExternalIdentityMappingDoc = {
    provider: spent.integrationSlug,
    externalSubject: spent.externalSenderId,
    userId,
    verifiedAt: (deps.now ?? (() => new Date()))(),
    expiresAt: null,
    verifiedVia: "bind_link",
  };
  await deps.repo.upsertMapping(mapping);
  return mapping;
}
