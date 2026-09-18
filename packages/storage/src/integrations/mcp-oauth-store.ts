import { type McpAccount, validateMcpAccount } from "@tulipfarm/schema";
import type { Queryable } from "../ports/transaction";

export interface McpOAuthBinding {
  readonly businessId: string;
  readonly integrationKey: string;
  readonly accountId: string;
  readonly accountRevision: number;
  readonly definitionDigest: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly callbackUrl: string;
  readonly issuer: string;
}

export interface McpOAuthAttempt {
  readonly stateDigest: string;
  readonly binding: McpOAuthBinding;
  readonly secretRef: string;
  readonly expiresAt: string;
}

export interface McpOAuthRefreshClaim {
  readonly businessId: string;
  readonly accountId: string;
  readonly accountRevision: number;
  readonly generation: number;
  readonly claimId: string;
}

export const MCP_OAUTH_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mcp_oauth_attempts (
    state_digest text PRIMARY KEY,
    business_id text NOT NULL,
    account_id text NOT NULL,
    binding jsonb NOT NULL,
    secret_ref text NOT NULL,
    expires_at timestamptz NOT NULL,
    FOREIGN KEY (business_id, account_id) REFERENCES mcp_accounts (business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS mcp_oauth_attempts_expiry_idx
    ON mcp_oauth_attempts (expires_at)`,
  `CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_claims (
    business_id text NOT NULL,
    account_id text NOT NULL,
    account_revision bigint NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    claim_id text,
    expires_at timestamptz,
    PRIMARY KEY (business_id, account_id),
    FOREIGN KEY (business_id, account_id) REFERENCES mcp_accounts (business_id, id)
  )`,
] as const;

export class McpOAuthStore {
  constructor(private readonly db: Queryable) {}

  async create(attempt: McpOAuthAttempt): Promise<boolean> {
    const { rows } = await this.db.query<{ state_digest: string }>(
      `INSERT INTO mcp_oauth_attempts
         (state_digest, business_id, account_id, binding, secret_ref, expires_at)
       SELECT $1, $2, $3, $4::jsonb, $5, $6 FROM mcp_accounts
       WHERE business_id = $2 AND id = $3 AND revision = $7
         AND document->>'status' <> 'revoked'
         AND document->>'definitionDigest' = $8
       ON CONFLICT DO NOTHING RETURNING state_digest`,
      [
        attempt.stateDigest,
        attempt.binding.businessId,
        attempt.binding.accountId,
        JSON.stringify(attempt.binding),
        attempt.secretRef,
        attempt.expiresAt,
        attempt.binding.accountRevision,
        attempt.binding.definitionDigest,
      ]
    );
    return rows.length === 1;
  }

  async consume(
    stateDigest: string,
    binding: Omit<McpOAuthBinding, "issuer" | "accountRevision" | "definitionDigest">,
    now: Date
  ): Promise<McpOAuthAttempt | undefined> {
    const { rows } = await this.db.query<{
      state_digest: string;
      binding: McpOAuthBinding;
      secret_ref: string;
      expires_at: Date;
    }>(
      `DELETE FROM mcp_oauth_attempts
       WHERE state_digest = $1 AND business_id = $2 AND account_id = $3
         AND binding->>'integrationKey' = $4 AND binding->>'principalId' = $5
         AND binding->>'sessionId' = $6 AND binding->>'callbackUrl' = $7
         AND expires_at > $8
       RETURNING state_digest, binding, secret_ref, expires_at`,
      [
        stateDigest,
        binding.businessId,
        binding.accountId,
        binding.integrationKey,
        binding.principalId,
        binding.sessionId,
        binding.callbackUrl,
        now,
      ]
    );
    const row = rows[0];
    return row
      ? {
          stateDigest: row.state_digest,
          binding: row.binding,
          secretRef: row.secret_ref,
          expiresAt: row.expires_at.toISOString(),
        }
      : undefined;
  }

  async claimRefresh(
    businessId: string,
    accountId: string,
    accountRevision: number,
    claimId: string,
    now: Date,
    expiresAt: Date
  ): Promise<McpOAuthRefreshClaim | undefined> {
    const { rows } = await this.db.query<{ generation: string | number }>(
      `INSERT INTO mcp_oauth_refresh_claims
         (business_id, account_id, account_revision, generation, claim_id, expires_at)
       SELECT $1, $2, $3, 1, $4, $6 FROM mcp_accounts
       WHERE business_id = $1 AND id = $2 AND revision = $3
         AND document->>'status' = 'active'
       ON CONFLICT (business_id, account_id) DO UPDATE
       SET account_revision = EXCLUDED.account_revision,
           generation = mcp_oauth_refresh_claims.generation + 1,
           claim_id = EXCLUDED.claim_id, expires_at = EXCLUDED.expires_at
       WHERE mcp_oauth_refresh_claims.claim_id IS NULL
          OR mcp_oauth_refresh_claims.expires_at <= $5
       RETURNING generation`,
      [businessId, accountId, accountRevision, claimId, now, expiresAt]
    );
    return rows[0]
      ? { businessId, accountId, accountRevision, claimId, generation: Number(rows[0].generation) }
      : undefined;
  }

  async currentRefresh(claim: McpOAuthRefreshClaim, now: Date): Promise<boolean> {
    const { rows } = await this.db.query<{ claim_id: string }>(
      `SELECT c.claim_id FROM mcp_oauth_refresh_claims c
       JOIN mcp_accounts a ON a.business_id = c.business_id AND a.id = c.account_id
       WHERE c.business_id = $1 AND c.account_id = $2 AND c.account_revision = $3
         AND c.generation = $4 AND c.claim_id = $5 AND c.expires_at > $6
         AND a.revision = $3 AND a.document->>'status' = 'active'`,
      [
        claim.businessId,
        claim.accountId,
        claim.accountRevision,
        claim.generation,
        claim.claimId,
        now,
      ]
    );
    return rows.length === 1;
  }

  async releaseRefresh(claim: McpOAuthRefreshClaim): Promise<void> {
    await this.db.query(
      `UPDATE mcp_oauth_refresh_claims SET claim_id = NULL, expires_at = NULL
       WHERE business_id = $1 AND account_id = $2 AND account_revision = $3
         AND generation = $4 AND claim_id = $5`,
      [claim.businessId, claim.accountId, claim.accountRevision, claim.generation, claim.claimId]
    );
  }

  async publishRefresh(
    claim: McpOAuthRefreshClaim,
    account: McpAccount,
    now: Date
  ): Promise<boolean> {
    validateMcpAccount(account);
    if (
      account.businessId !== claim.businessId ||
      account.id !== claim.accountId ||
      account.revision !== claim.accountRevision ||
      account.status !== "active"
    ) {
      throw new Error("MCP refresh cannot change account authority");
    }
    const { rows } = await this.db.query<{ id: string }>(
      `WITH held AS MATERIALIZED (
         SELECT account_id FROM mcp_oauth_refresh_claims
         WHERE business_id = $1 AND account_id = $2 AND account_revision = $3
           AND generation = $4 AND claim_id = $5 AND expires_at > $6
         FOR UPDATE
       )
       UPDATE mcp_accounts
       SET document = jsonb_set(jsonb_set(jsonb_set(document,
         '{secretBindings}', $7::jsonb), '{expiresAt}', $8::jsonb), '{updatedAt}', $9::jsonb)
       WHERE business_id = $1 AND id = $2 AND revision = $3
         AND document->>'status' = 'active' AND id IN (SELECT account_id FROM held)
         AND document->>'definitionDigest' = $10
       RETURNING id`,
      [
        claim.businessId,
        claim.accountId,
        claim.accountRevision,
        claim.generation,
        claim.claimId,
        now,
        JSON.stringify(account.secretBindings),
        JSON.stringify(account.expiresAt),
        JSON.stringify(account.updatedAt),
        account.definitionDigest,
      ]
    );
    return rows.length === 1;
  }

  async failRefresh(
    claim: McpOAuthRefreshClaim,
    oauthSecretRef: string,
    now: Date
  ): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      `WITH held AS MATERIALIZED (
         SELECT account_id FROM mcp_oauth_refresh_claims
         WHERE business_id = $1 AND account_id = $2 AND account_revision = $3
           AND generation = $4 AND claim_id = $5 AND expires_at > $8
         FOR UPDATE
       )
       UPDATE mcp_accounts SET document = jsonb_set(jsonb_set(document,
         '{status}', '"action_required"'), '{updatedAt}', $6::jsonb)
       WHERE business_id = $1 AND id = $2 AND revision = $3
         AND document->>'status' = 'active' AND id IN (SELECT account_id FROM held)
         AND document->'secretBindings'->>'oauth' = $7
       RETURNING id`,
      [
        claim.businessId,
        claim.accountId,
        claim.accountRevision,
        claim.generation,
        claim.claimId,
        JSON.stringify(now.toISOString()),
        oauthSecretRef,
        now,
      ]
    );
    return rows.length === 1;
  }

  async removeExpired(now: Date): Promise<string[]> {
    const { rows } = await this.db.query<{ secret_ref: string }>(
      "DELETE FROM mcp_oauth_attempts WHERE expires_at <= $1 RETURNING secret_ref",
      [now]
    );
    return rows.map((row) => row.secret_ref);
  }
}
