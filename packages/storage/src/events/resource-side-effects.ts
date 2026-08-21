import { withTransaction } from "../pg/transaction-helpers";
import type { Queryable } from "../ports/transaction";
export type ResourceMutationKind = "create" | "update" | "delete";
export interface ResourceSideEffect {
  readonly kind: ResourceMutationKind;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly record: Record<string, unknown>;
  readonly actorId?: string;
  readonly afterHook?: { readonly source: string; readonly hash?: string };
}
export interface ClaimedResourceSideEffect {
  readonly id: string;
  readonly effect: ResourceSideEffect;
  readonly attempts: number;
}
export const RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS resource_create_requests (resource_type text NOT NULL, caller_id text NOT NULL, idempotency_key text NOT NULL, resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (resource_type, caller_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS resource_side_effect_outbox (id uuid PRIMARY KEY, effect jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'quarantined')), attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), lease_owner text, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, CHECK ((status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR status <> 'leased'))`,
  `CREATE INDEX IF NOT EXISTS resource_side_effect_outbox_claim_idx ON resource_side_effect_outbox (status, lease_until, created_at)`,
] as const;
export async function writeResourceSideEffect(
  tx: Queryable,
  id: string,
  effect: ResourceSideEffect
): Promise<void> {
  await tx.query(`INSERT INTO resource_side_effect_outbox (id, effect) VALUES ($1, $2::jsonb)`, [
    id,
    JSON.stringify(effect),
  ]);
}
export class ResourceSideEffectOutbox {
  constructor(private readonly database: Queryable) {}
  async claim(
    owner: string,
    limit: number,
    leaseMs: number
  ): Promise<readonly ClaimedResourceSideEffect[]> {
    return withTransaction(
      this.database,
      async (tx) =>
        (
          await tx.query<ClaimedResourceSideEffect>(
            `WITH candidates AS (SELECT id FROM resource_side_effect_outbox WHERE status = 'pending' OR (status = 'leased' AND lease_until <= now()) ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE resource_side_effect_outbox AS outbox SET status = 'leased', attempts = outbox.attempts + 1, lease_owner = $2, lease_until = now() + ($3 * interval '1 millisecond') FROM candidates WHERE outbox.id = candidates.id RETURNING outbox.id, outbox.effect, outbox.attempts`,
            [limit, owner, leaseMs]
          )
        ).rows
    );
  }
  async complete(id: string, owner: string): Promise<boolean> {
    return (
      (
        await this.database.query(
          `UPDATE resource_side_effect_outbox SET status = 'delivered', lease_owner = NULL, lease_until = NULL, delivered_at = now() WHERE id = $1 AND status = 'leased' AND lease_owner = $2 RETURNING id`,
          [id, owner]
        )
      ).rows.length === 1
    );
  }
  async fail(id: string, owner: string, maxAttempts: number): Promise<boolean> {
    return (
      (
        await this.database.query(
          `UPDATE resource_side_effect_outbox SET status = CASE WHEN attempts >= $3 THEN 'quarantined' ELSE 'pending' END, lease_owner = NULL, lease_until = NULL WHERE id = $1 AND status = 'leased' AND lease_owner = $2 RETURNING id`,
          [id, owner, maxAttempts]
        )
      ).rows.length === 1
    );
  }
}
export class ResourceSideEffectDispatcher {
  constructor(
    private readonly outbox: ResourceSideEffectOutbox,
    private readonly owner: string,
    private readonly deliver: (effect: ResourceSideEffect) => Promise<void>,
    private readonly batchSize = 25,
    private readonly leaseMs = 60_000,
    private readonly maxAttempts = 10
  ) {}
  async dispatchBatch(): Promise<void> {
    for (const message of await this.outbox.claim(this.owner, this.batchSize, this.leaseMs)) {
      try {
        await this.deliver(message.effect);
        await this.outbox.complete(message.id, this.owner);
      } catch {
        await this.outbox.fail(message.id, this.owner, this.maxAttempts);
      }
    }
  }
}
