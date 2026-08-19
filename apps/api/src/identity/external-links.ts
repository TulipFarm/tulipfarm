import { createHash, randomBytes } from "node:crypto";
import {
  assertExternalIdentityMapped,
  ExternalIdentityDeniedError,
  type ExternalIdentityMapping,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { Queryable } from "../db";

/** External subjects act only through verified mappings; link tokens are one-use and expiring. */

/** Link provenance is audit evidence; null means the row predates this distinction. */
export type IdentityVerificationMethod = "link_token" | "manifest_email" | "bind_link";

/**
 * Verification methods strong enough to grant Knowledge document access.
 *
 * One mapping row answers two unrelated questions — *who is talking to the bot* and *what may they
 * read* — and those need different evidence. Both members here prove control of the provider
 * account **and** the Tulip account: `link_token` is minted for an authenticated user and redeemed
 * with the provider subject; `bind_link` delivers a nonce to the provider account and is redeemed
 * while authenticated.
 *
 * `manifest_email` deliberately does not qualify. It matches a user by an email the *provider*
 * reports, and a Slack Connect or guest counterparty administers their own users' addresses — so
 * it is an assertion from outside our trust boundary, not proof. Such a row still identifies a
 * chat sender; it simply carries no grant. See ticket 06.
 *
 * **Scope, precisely.** This closes the path where a weak mapping puts a principal into a captured
 * source ACL or satisfies a live membership check. It does **not** close impersonation: a
 * `manifest_email` sender is still resolved to the matched user by `resolveExternalIdentity`, owns
 * the resulting Turn as that user, and `query_knowledge` derives its read principal from the Turn
 * owner — so they still inherit that user's own reads. Ticket 06 records that as open.
 */
export const PROVEN_LINK_VERIFICATION: readonly IdentityVerificationMethod[] = [
  "link_token",
  "bind_link",
];

/** Null provenance is not evidence, so it is refused alongside the weak methods. */
export function isProvenLink(doc: { verifiedVia?: IdentityVerificationMethod | null }): boolean {
  const via = doc.verifiedVia;
  return via !== null && via !== undefined && PROVEN_LINK_VERIFICATION.includes(via);
}

export interface ExternalIdentityMappingDoc {
  provider: string;
  externalSubject: string;
  userId: string;
  verifiedAt: Date;
  expiresAt: Date | null;
  verifiedVia?: IdentityVerificationMethod | null;
}

export interface ExternalLinkTokenDoc {
  tokenHash: string;
  provider: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Bind offers are spendable rows because signatures alone cannot be revoked. */
export interface ChannelBindTokenDoc {
  nonceHash: string;
  integrationSlug: string;
  externalSenderId: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedBy: string | null;
}

export interface ExternalIdentityRepo {
  findMapping(
    provider: string,
    externalSubject: string
  ): Promise<ExternalIdentityMappingDoc | null>;
  listMappingsForUser(userId: string): Promise<ExternalIdentityMappingDoc[]>;
  /**
   * Mappings strong enough to grant Knowledge documents. Anything deciding document access must
   * call this rather than filtering `listMappingsForUser` itself, so a new call site cannot
   * silently omit the grade check.
   */
  listProvenMappingsForUser(userId: string): Promise<ExternalIdentityMappingDoc[]>;
  upsertMapping(mapping: ExternalIdentityMappingDoc): Promise<void>;
  deleteMapping(provider: string, externalSubject: string): Promise<void>;
  createLinkToken(token: ExternalLinkTokenDoc): Promise<void>;
  /** Atomically marks the token consumed; returns null when unknown, expired, or already used. */
  consumeLinkToken(tokenHash: string): Promise<ExternalLinkTokenDoc | null>;
  createBindToken(token: ChannelBindTokenDoc): Promise<void>;
  /** Unspent state of a bind offer, for showing a confirmation page without spending it. */
  findBindToken(nonceHash: string): Promise<ChannelBindTokenDoc | null>;
  /** Atomically spends the nonce for one user; null when unknown, expired, or already spent. */
  consumeBindToken(nonceHash: string, userId: string): Promise<ChannelBindTokenDoc | null>;
}

export const DEFAULT_LINK_TOKEN_TTL_SECONDS = 900;

export function hashLinkToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function rowToMapping(row: Record<string, unknown>): ExternalIdentityMappingDoc {
  return {
    provider: row.provider as string,
    externalSubject: row.external_subject as string,
    userId: row.user_id as string,
    verifiedAt: row.verified_at as Date,
    expiresAt: (row.expires_at as Date | null) ?? null,
    verifiedVia: (row.verified_via as IdentityVerificationMethod | null) ?? null,
  };
}

function rowToBindToken(row: Record<string, unknown>): ChannelBindTokenDoc {
  return {
    nonceHash: row.nonce_hash as string,
    integrationSlug: row.integration_slug as string,
    externalSenderId: row.external_sender_id as string,
    issuedAt: row.issued_at as Date,
    expiresAt: row.expires_at as Date,
    consumedAt: (row.consumed_at as Date | null) ?? null,
    consumedBy: (row.consumed_by as string | null) ?? null,
  };
}

function rowToLinkToken(row: Record<string, unknown>): ExternalLinkTokenDoc {
  return {
    tokenHash: row.token_hash as string,
    provider: row.provider as string,
    userId: row.user_id as string,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    consumedAt: (row.consumed_at as Date | null) ?? null,
  };
}

export class PgExternalIdentityRepo implements ExternalIdentityRepo {
  constructor(private readonly q: Queryable) {}

  async findMapping(
    provider: string,
    externalSubject: string
  ): Promise<ExternalIdentityMappingDoc | null> {
    const { rows } = await this.q.query(
      "SELECT * FROM external_identity_mappings WHERE provider = $1 AND external_subject = $2",
      [provider, externalSubject]
    );
    return rows.length > 0 ? rowToMapping(rows[0]) : null;
  }

  async listMappingsForUser(userId: string): Promise<ExternalIdentityMappingDoc[]> {
    const { rows } = await this.q.query(
      "SELECT * FROM external_identity_mappings WHERE user_id = $1 ORDER BY provider, external_subject",
      [userId]
    );
    return rows.map(rowToMapping);
  }

  async listProvenMappingsForUser(userId: string): Promise<ExternalIdentityMappingDoc[]> {
    // Filtered in SQL rather than after the fact so a weak row never reaches a caller that
    // decides document access.
    const { rows } = await this.q.query(
      `SELECT * FROM external_identity_mappings
       WHERE user_id = $1 AND verified_via = ANY($2::text[])
       ORDER BY provider, external_subject`,
      [userId, PROVEN_LINK_VERIFICATION]
    );
    return rows.map(rowToMapping);
  }

  async upsertMapping(mapping: ExternalIdentityMappingDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO external_identity_mappings (provider, external_subject, user_id, verified_at, expires_at, verified_via)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, external_subject)
       DO UPDATE SET user_id = EXCLUDED.user_id, verified_at = EXCLUDED.verified_at,
                     expires_at = EXCLUDED.expires_at, verified_via = EXCLUDED.verified_via`,
      [
        mapping.provider,
        mapping.externalSubject,
        mapping.userId,
        mapping.verifiedAt,
        mapping.expiresAt,
        mapping.verifiedVia ?? null,
      ]
    );
  }

  async deleteMapping(provider: string, externalSubject: string): Promise<void> {
    await this.q.query(
      "DELETE FROM external_identity_mappings WHERE provider = $1 AND external_subject = $2",
      [provider, externalSubject]
    );
  }

  async createLinkToken(token: ExternalLinkTokenDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO external_link_tokens (token_hash, provider, user_id, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        token.tokenHash,
        token.provider,
        token.userId,
        token.createdAt,
        token.expiresAt,
        token.consumedAt,
      ]
    );
  }

  async consumeLinkToken(tokenHash: string): Promise<ExternalLinkTokenDoc | null> {
    const { rows } = await this.q.query(
      `UPDATE external_link_tokens SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [tokenHash]
    );
    return rows.length > 0 ? rowToLinkToken(rows[0]) : null;
  }

  async createBindToken(token: ChannelBindTokenDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO channel_bind_tokens
         (nonce_hash, integration_slug, external_sender_id, issued_at, expires_at, consumed_at, consumed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        token.nonceHash,
        token.integrationSlug,
        token.externalSenderId,
        token.issuedAt,
        token.expiresAt,
        token.consumedAt,
        token.consumedBy,
      ]
    );
  }

  async findBindToken(nonceHash: string): Promise<ChannelBindTokenDoc | null> {
    const { rows } = await this.q.query(
      `SELECT * FROM channel_bind_tokens
       WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [nonceHash]
    );
    return rows.length > 0 ? rowToBindToken(rows[0]) : null;
  }

  async consumeBindToken(nonceHash: string, userId: string): Promise<ChannelBindTokenDoc | null> {
    const { rows } = await this.q.query(
      `UPDATE channel_bind_tokens SET consumed_at = now(), consumed_by = $2
       WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [nonceHash, userId]
    );
    return rows.length > 0 ? rowToBindToken(rows[0]) : null;
  }
}

export async function mintLinkToken(
  repo: ExternalIdentityRepo,
  input: { userId: string; provider: string; ttlSeconds?: number }
): Promise<{ raw: string; expiresAt: Date }> {
  const raw = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlSeconds ?? DEFAULT_LINK_TOKEN_TTL_SECONDS) * 1000
  );
  await repo.createLinkToken({
    tokenHash: hashLinkToken(raw),
    provider: input.provider,
    userId: input.userId,
    createdAt: now,
    expiresAt,
    consumedAt: null,
  });
  return { raw, expiresAt };
}

export type LinkRedemptionDenialReason = "invalid_token" | "provider_mismatch";

export class LinkRedemptionDeniedError extends Error {
  constructor(
    public readonly reason: LinkRedemptionDenialReason,
    message: string
  ) {
    super(message);
    this.name = "LinkRedemptionDeniedError";
  }
}

/** Consume link tokens atomically before writing mappings so replays create no second mapping. */
export async function redeemLinkToken(
  repo: ExternalIdentityRepo,
  input: { raw: string; provider: string; externalSubject: string }
): Promise<ExternalIdentityMappingDoc> {
  const token = await repo.consumeLinkToken(hashLinkToken(input.raw));
  if (!token) {
    throw new LinkRedemptionDeniedError("invalid_token", "link token is unknown, used, or expired");
  }
  if (token.provider !== input.provider) {
    throw new LinkRedemptionDeniedError(
      "provider_mismatch",
      "link token was not minted for this provider"
    );
  }
  const mapping: ExternalIdentityMappingDoc = {
    provider: input.provider,
    externalSubject: input.externalSubject,
    userId: token.userId,
    verifiedAt: new Date(),
    expiresAt: null,
    verifiedVia: "link_token",
  };
  await repo.upsertMapping(mapping);
  return mapping;
}

function toAuthzMapping(doc: ExternalIdentityMappingDoc): ExternalIdentityMapping {
  return {
    businessId: DEPLOYMENT_BUSINESS_ID,
    provider: doc.provider,
    externalSubject: doc.externalSubject,
    principalId: doc.userId,
    verifiedAt: doc.verifiedAt,
    ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}),
  };
}

/** Deny unmapped and expired external subjects; channel membership is never a mapping. */
export async function resolveExternalIdentity(
  repo: ExternalIdentityRepo,
  provider: string,
  externalSubject: string,
  now: Date = new Date()
): Promise<string> {
  return (await resolveExternalSender(repo, provider, externalSubject, now)).userId;
}

/**
 * The same check as {@link resolveExternalIdentity}, keeping the evidence that produced the match.
 *
 * Callers that only need to know *who* the sender is should use `resolveExternalIdentity`. Callers
 * deciding what the sender may *do* need `verifiedVia` too, because the two questions take
 * different evidence — see `PROVEN_LINK_VERIFICATION`.
 */
export async function resolveExternalSender(
  repo: ExternalIdentityRepo,
  provider: string,
  externalSubject: string,
  now: Date = new Date()
): Promise<{ readonly userId: string; readonly verifiedVia?: IdentityVerificationMethod }> {
  const doc = await repo.findMapping(provider, externalSubject);
  const mapping = doc ? toAuthzMapping(doc) : undefined;
  assertExternalIdentityMapped(mapping, DEPLOYMENT_BUSINESS_ID, now);
  return {
    userId: mapping.principalId,
    ...(doc?.verifiedVia ? { verifiedVia: doc.verifiedVia } : {}),
  };
}

export { ExternalIdentityDeniedError };
