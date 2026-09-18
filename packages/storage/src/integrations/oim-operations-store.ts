import type { Queryable } from "../ports";

export interface OimConnectionOperations {
  readonly webhook: {
    readonly state: string;
    readonly desiredState: string;
    readonly attempts: number;
    readonly nextAttemptAt: string;
    readonly hasError: boolean;
    readonly updatedAt: string;
  } | null;
  readonly delivery: {
    readonly pending: number;
    readonly retrying: number;
    readonly deadLetter: number;
    readonly dispatched: number;
    readonly nextAttemptAt: string | null;
    readonly hasError: boolean;
  };
  readonly polling: { readonly nextPollAt: string; readonly leaseExpiresAt: string | null } | null;
  readonly sync: readonly {
    readonly sourceKindId: string;
    readonly scope: string;
    readonly inProgress: boolean;
    readonly pendingDeletions: number;
    readonly requiresFullRebuild: boolean;
    readonly updatedAt: string;
  }[];
}

export class OimOperationsStore {
  constructor(private readonly queryable: Queryable) {}

  async read(businessId: string, connectionId: string): Promise<OimConnectionOperations> {
    const args = [businessId, connectionId];
    const [webhook, delivery, polling, sync] = await Promise.all([
      this.queryable.query<NonNullable<OimConnectionOperations["webhook"]>>(
        `SELECT state, desired_state AS "desiredState", attempts,
                next_attempt_at::text AS "nextAttemptAt", last_error IS NOT NULL AS "hasError",
                updated_at::text AS "updatedAt"
           FROM oim_webhook_registrations WHERE business_id = $1 AND connection_id = $2`,
        args
      ),
      this.queryable.query<OimConnectionOperations["delivery"]>(
        `SELECT count(*) FILTER (WHERE state IN ('accepted', 'normalized'))::integer AS pending,
                count(*) FILTER (WHERE state IN ('accepted', 'normalized') AND attempts > 0)::integer AS retrying,
                count(*) FILTER (WHERE state = 'dead_letter')::integer AS "deadLetter",
                count(*) FILTER (WHERE state = 'dispatched')::integer AS dispatched,
                min(next_attempt_at) FILTER (WHERE state IN ('accepted', 'normalized'))::text AS "nextAttemptAt",
                coalesce(bool_or(last_error IS NOT NULL), false) AS "hasError"
           FROM webhook_deliveries WHERE business_id = $1 AND connection_id = $2`,
        args
      ),
      this.queryable.query<NonNullable<OimConnectionOperations["polling"]>>(
        `SELECT next_poll_at::text AS "nextPollAt", lease_expires_at::text AS "leaseExpiresAt"
           FROM polling_ingress_state WHERE business_id = $1 AND connection_id = $2`,
        args
      ),
      this.queryable.query<OimConnectionOperations["sync"][number]>(
        `SELECT source_kind AS "sourceKindId", scope_key AS scope,
                scan_id IS NOT NULL AS "inProgress",
                jsonb_array_length(pending_deletion_item_ids) AS "pendingDeletions",
                requires_full_rebuild AS "requiresFullRebuild", updated_at::text AS "updatedAt"
           FROM oim_knowledge_scan_checkpoints
          WHERE business_id = $1 AND connection_id = $2 ORDER BY source_kind, scope_key`,
        args
      ),
    ]);
    return {
      webhook: webhook.rows[0] ?? null,
      delivery: delivery.rows[0] ?? {
        pending: 0,
        retrying: 0,
        deadLetter: 0,
        dispatched: 0,
        nextAttemptAt: null,
        hasError: false,
      },
      polling: polling.rows[0] ?? null,
      sync: sync.rows,
    };
  }
}
