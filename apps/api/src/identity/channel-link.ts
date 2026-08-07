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

/**
 * Channel identity binding: the *reverse* of `external-links.ts`. There, a signed-in user mints a
 * token and the integration's service identity redeems it with the subject it verified. Here nobody
 * is signed in yet — an unknown Slack or Telegram sender messaged us, and the only thing we can do
 * is send them a link and let whoever opens it, in an authenticated TulipFarm session, say "yes,
 * that sender is me".
 *
 * The link therefore carries no user identity, because none is known: only `{slug, senderId,
 * issuedAt, nonce}` under an HMAC. Three properties make that safe to hand to an unverified sender:
 *
 *  - **Signed.** The claims come back to us as they left, so a sender cannot rewrite the link to
 *    bind someone else's channel id to their own account.
 *  - **Short-lived.** 15 minutes, enforced from the signed `issuedAt` *and* the stored row, so a
 *    link scraped from a channel archive is worthless.
 *  - **Single-use.** The nonce is spent atomically on redemption. A signature alone cannot be
 *    revoked, which is exactly why the row exists.
 *
 * A leaked link is still useless without a session, and the confirmation page names the exact
 * sender and account before anything is written — so the person clicking always sees what they are
 * about to claim.
 */

/** Where the HMAC key lives. Held in the secret store, never a constant compiled into the build. */
export const CHANNEL_BIND_SIGNING_KEY = "channel-bind.signing-key";

export const CHANNEL_BIND_TTL_MS = 15 * 60_000;

/** Just enough of `SecretsService` to hold one key, so callers need not carry the whole service. */
export type ChannelBindKeyStore = SigningKeyStore;

/**
 * Reads the signing key, provisioning one on first use so a fresh deployment needs no operator
 * step. Existence is checked through `list` rather than by catching `get`, because a secret store
 * that is merely *unreachable* also fails `get` — and minting a second key in that case would
 * silently invalidate every link already in flight.
 */
export async function resolveChannelBindKey(secrets: ChannelBindKeyStore): Promise<Buffer> {
  return resolveSigningKey(secrets, CHANNEL_BIND_SIGNING_KEY);
}

/** Memoizes the key for the process. It never rotates, and a bind link outlives no boot by design. */
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

/**
 * Verifies the signature and returns the claims, or null for anything malformed. Comparison is
 * constant-time so a forger learns nothing from how long a rejection took.
 */
export function parseChannelBindToken(key: Buffer, token: string): ChannelBindClaims | null {
  const claims = verifyToken<ChannelBindClaims>(key, token);
  return claims !== null && isChannelBindClaims(claims) ? claims : null;
}

export type ChannelBindDenialReason = "invalid_token";

/**
 * One coarse reason for every rejection. Whether a link was forged, expired, or already spent is
 * not something the holder of a rejected link is entitled to learn.
 */
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

/** The channel identity a confirmation page names, so the person confirming sees what they claim. */
export interface ChannelBindOffer {
  slug: string;
  senderId: string;
  expiresAt: Date;
}

/**
 * Issues one bind offer for an unlinked sender. The nonce row is written *before* the token is
 * returned, so a token can never exist that has nothing to spend.
 */
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

/**
 * Resolves a token to the offer it stands for, checking everything redemption checks *except*
 * spending the nonce. The confirmation page uses this: showing someone a binding they cannot
 * complete, or completing one they were never shown, are both worse than one extra read.
 */
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
  // Expiry is enforced from the signed claims as well as the row: the claims bound the window even
  // if a row somehow outlives it, and the row bounds it even if the clock moved.
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

/**
 * Binds the sender to the confirming user. The nonce is spent atomically before the mapping is
 * written, so two clicks — or two tabs — produce one mapping and one refusal, never two bindings.
 */
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
