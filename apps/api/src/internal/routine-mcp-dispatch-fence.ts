import type { Queryable } from "@tulipfarm/storage";

export const ROUTINE_MCP_DISPATCH_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS routine_mcp_dispatch_claims (
    business_id text NOT NULL,
    effect_id uuid NOT NULL,
    attempt integer NOT NULL CHECK (attempt > 0),
    intent_digest text NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, effect_id, attempt),
    FOREIGN KEY (business_id, effect_id, attempt)
      REFERENCES effect_attempts (business_id, effect_id, attempt)
  )`,
] as const;

export interface RoutineMcpDispatchFence {
  /** Durable, one-use admission. A lost response must never admit the same attempt again. */
  claim(input: {
    readonly businessId: string;
    readonly effectId: string;
    readonly attempt: number;
    readonly intentDigest: string;
  }): Promise<boolean>;
}

export class PgRoutineMcpDispatchFence implements RoutineMcpDispatchFence {
  constructor(private readonly db: Queryable) {}

  async claim(input: Parameters<RoutineMcpDispatchFence["claim"]>[0]) {
    const result = await this.db.query<{ effect_id: string }>(
      `INSERT INTO routine_mcp_dispatch_claims
        (business_id, effect_id, attempt, intent_digest)
       SELECT business_id, effect_id, $3, intent_digest
       FROM effect_records
       WHERE business_id = $1 AND effect_id = $2 AND state = 'dispatched'
         AND intent_digest = $4
       ON CONFLICT (business_id, effect_id, attempt) DO NOTHING
       RETURNING effect_id`,
      [input.businessId, input.effectId, input.attempt, input.intentDigest]
    );
    return result.rows.length === 1;
  }
}
