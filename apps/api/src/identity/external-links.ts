import { createHash, randomBytes } from "node:crypto";
import {
  assertExternalIdentityMapped,
  ExternalIdentityDeniedError,
  type ExternalIdentityMapping,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { Queryable } from "../db";

/**
 * External identity linking (SPEC §12): Slack/Telegram/GitHub/etc. subjects only act for a
 * TulipFarm user through a verified mapping. Unmapped senders are denied — there is no implicit
 * provisioning. A link is established by an authenticated user minting a one-use, expiring link
 * token and the external side redeeming it with the subject it proved, so redeeming a captured
 * token twice cannot create a second mapping (SPEC §24 replay).
 */

export interface ExternalIdentityMappingDoc {
  provider: string;
  externalSubject: string;
  userId: string;
  verifiedAt: Date;
  expiresAt: Date | null;
}

export interface ExternalLinkTokenDoc {
  tokenHash: string;
  provider: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface ExternalIdentityRepo {
  findMapping(
    provider: string,
    externalSubject: string
  ): Promise<ExternalIdentityMappingDoc | null>;
  listMappingsForUser(userId: string): Promise<ExternalIdentityMappingDoc[]>;
  upsertMapping(mapping: ExternalIdentityMappingDoc): Promise<void>;
  deleteMapping(provider: string, externalSubject: string): Promise<void>;
  createLinkToken(token: ExternalLinkTokenDoc): Promise<void>;
  /** Atomically marks the token consumed; returns null when unknown, expired, or already used. */
  consumeLinkToken(tokenHash: string): Promise<ExternalLinkTokenDoc | null>;
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

  async upsertMapping(mapping: ExternalIdentityMappingDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO external_identity_mappings (provider, external_subject, user_id, verified_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, external_subject)
       DO UPDATE SET user_id = EXCLUDED.user_id, verified_at = EXCLUDED.verified_at, expires_at = EXCLUDED.expires_at`,
      [
        mapping.provider,
        mapping.externalSubject,
        mapping.userId,
        mapping.verifiedAt,
        mapping.expiresAt,
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

/**
 * Redeems a link token for one external subject. The token is consumed atomically before the
 * mapping is written, so a replayed token — even concurrently — never produces a second mapping.
 */
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

/**
 * Resolves an external subject to the user it is verified for, or throws
 * `ExternalIdentityDeniedError`. Unmapped and expired subjects are denied — membership of a
 * channel or thread never stands in for a mapping.
 */
export async function resolveExternalIdentity(
  repo: ExternalIdentityRepo,
  provider: string,
  externalSubject: string,
  now: Date = new Date()
): Promise<string> {
  const doc = await repo.findMapping(provider, externalSubject);
  const mapping = doc ? toAuthzMapping(doc) : undefined;
  assertExternalIdentityMapped(mapping, DEPLOYMENT_BUSINESS_ID, now);
  return mapping.principalId;
}

export { ExternalIdentityDeniedError };
