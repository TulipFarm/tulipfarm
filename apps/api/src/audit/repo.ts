/** PostgreSQL audit repo; unique `(business_id, chain_index)` closes append races. */

import {
  AuditAppendConflictError,
  type AuditEvent,
  type AuditEventRepo,
  type AuditPrincipalRef,
  recomputeEventHash,
} from "@tulipfarm/audit";
import type { Queryable } from "../db";

/** Postgres' unique-violation SQLSTATE, raised by `audit_events_chain_idx`. */
const UNIQUE_VIOLATION = "23505";

/** Scopes a conflict rollback to the audit insert, leaving the caller's transaction alive. */
const SAVEPOINT = "audit_append";

/** Page-size ceiling for the reader — a runaway `limit` must not scan the whole ledger. */
export const AUDIT_PAGE_MAX = 200;
export const AUDIT_PAGE_DEFAULT = 50;

function pageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return AUDIT_PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(requested), 1), AUDIT_PAGE_MAX);
}

export interface AuditPageQuery {
  readonly limit?: number;
  /** Exclusive upper bound: the `chain_index` of the last row on the previous page. */
  readonly cursor?: number;
  readonly action?: string;
  readonly actorId?: string;
  readonly decision?: string;
}

export interface AuditPage {
  readonly items: readonly AuditEvent[];
  readonly nextCursor: number | null;
}

const COLUMNS = `id, business_id, chain_index, previous_hash, hash, actor_principal_id,
  effective_principal_id, agent_id, run_id, state_id, action, target, decision, reason_codes,
  guardrail_digest, bundle_digest, source_classification, destination_classification,
  request_hash, result_hash, correlation_id, causation_id, occurred_at, safe_metadata, safe_refs`;

function principal(principalId: string, businessId: string): AuditPrincipalRef {
  return Object.freeze({ principalId, businessId });
}

/** Drops NULL fields so absent fields do not reappear as explicit `undefined`. */
function optional<T>(key: string, value: T | null | undefined): Record<string, T> {
  return value === null || value === undefined ? {} : { [key]: value };
}

function rowToEvent(row: Record<string, unknown>): AuditEvent {
  const businessId = row.business_id as string;
  return Object.freeze({
    id: row.id as string,
    businessId,
    // bigint arrives as a string from node-postgres; the chain index is well inside Number range.
    chainIndex: Number(row.chain_index),
    previousHash: (row.previous_hash as string | null) ?? null,
    hash: row.hash as string,
    actor: principal(row.actor_principal_id as string, businessId),
    effectivePrincipal: principal(row.effective_principal_id as string, businessId),
    action: row.action as string,
    target: row.target as string,
    decision: row.decision as AuditEvent["decision"],
    reasonCodes: Object.freeze([...((row.reason_codes as string[] | null) ?? [])]),
    correlationId: row.correlation_id as string,
    occurredAt: new Date(row.occurred_at as string),
    ...optional("agentId", row.agent_id as string | null),
    ...optional("runId", row.run_id as string | null),
    ...optional("stateId", row.state_id as string | null),
    ...optional("guardrailDigest", row.guardrail_digest as string | null),
    ...optional("bundleDigest", row.bundle_digest as string | null),
    ...optional("sourceClassification", row.source_classification as string | null),
    ...optional("destinationClassification", row.destination_classification as string | null),
    ...optional("requestHash", row.request_hash as string | null),
    ...optional("resultHash", row.result_hash as string | null),
    ...optional("causationId", row.causation_id as string | null),
    ...optional("safeMetadata", row.safe_metadata as Record<string, unknown> | null),
    ...optional("safeRefs", row.safe_refs as AuditEvent["safeRefs"] | null),
  }) as AuditEvent;
}

export class PgAuditEventRepo implements AuditEventRepo {
  /** Set `inTransaction` for transaction clients so conflicts use a savepoint. */
  constructor(
    private readonly db: Queryable,
    private readonly inTransaction = false
  ) {}

  /** Appends only if `event` extends the current tail; joins caller tx with `inTransaction`. */
  async append(event: AuditEvent): Promise<void> {
    if (recomputeEventHash(event) !== event.hash) {
      // The event was altered after it was hashed. Refuse rather than persist evidence that would
      // fail its own verification later — a broken chain is worse than a missing entry.
      throw new AuditAppendConflictError();
    }

    const params = [
      event.id,
      event.businessId,
      event.chainIndex,
      event.previousHash,
      event.hash,
      event.actor.principalId,
      event.effectivePrincipal.principalId,
      event.agentId ?? null,
      event.runId ?? null,
      event.stateId ?? null,
      event.action,
      event.target,
      event.decision,
      [...event.reasonCodes],
      event.guardrailDigest ?? null,
      event.bundleDigest ?? null,
      event.sourceClassification ?? null,
      event.destinationClassification ?? null,
      event.requestHash ?? null,
      event.resultHash ?? null,
      event.correlationId,
      event.causationId ?? null,
      event.occurredAt.toISOString(),
      event.safeMetadata === undefined ? null : JSON.stringify(event.safeMetadata),
      event.safeRefs === undefined ? null : JSON.stringify(event.safeRefs),
    ];

    let inserted: number;
    if (this.inTransaction) await this.db.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const { rows } = await this.db.query(
        `INSERT INTO audit_events (${COLUMNS})
         SELECT $1::uuid, $2, $3::bigint, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[],
                $15, $16, $17, $18, $19, $20, $21, $22, $23::timestamptz, $24::jsonb, $25::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_events WHERE business_id = $2 AND chain_index >= $3::bigint
         )
         AND CASE WHEN $3::bigint = 0
           THEN NOT EXISTS (SELECT 1 FROM audit_events WHERE business_id = $2)
           ELSE EXISTS (
             SELECT 1 FROM audit_events
             WHERE business_id = $2 AND chain_index = $3::bigint - 1 AND hash = $4
           )
         END
         RETURNING 1 AS ok`,
        params
      );
      inserted = rows.length;
    } catch (error) {
      // Lost the race to a concurrent writer at the same index. To the caller this is
      // indistinguishable from having read a stale tail, and AuditWriter treats both alike: it
      // re-reads the tail and retries with a recomputed hash — but only if the transaction is
      // still usable, which is what the savepoint below preserves.
      if ((error as { code?: string })?.code === UNIQUE_VIOLATION) {
        if (this.inTransaction) await this.db.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        throw new AuditAppendConflictError();
      }
      throw error;
    }

    if (this.inTransaction) await this.db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    if (inserted === 0) throw new AuditAppendConflictError();
  }

  async getLatest(businessId: string): Promise<AuditEvent | undefined> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM audit_events
       WHERE business_id = $1 ORDER BY chain_index DESC LIMIT 1`,
      [businessId]
    );
    return rows[0] ? rowToEvent(rows[0]) : undefined;
  }

  async listChain(businessId: string): Promise<AuditEvent[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM audit_events WHERE business_id = $1 ORDER BY chain_index ASC`,
      [businessId]
    );
    return rows.map(rowToEvent);
  }

  /** Reads one newest-first page; cursor is the unique per-business `chain_index`. */
  async listPage(businessId: string, options: AuditPageQuery = {}): Promise<AuditPage> {
    const limit = pageLimit(options.limit);
    const filters = ["business_id = $1"];
    const params: unknown[] = [businessId];

    if (options.cursor !== undefined) {
      params.push(options.cursor);
      filters.push(`chain_index < $${params.length}::bigint`);
    }
    if (options.action) {
      params.push(options.action);
      filters.push(`action = $${params.length}`);
    }
    if (options.actorId) {
      params.push(options.actorId);
      filters.push(`actor_principal_id = $${params.length}`);
    }
    if (options.decision) {
      params.push(options.decision);
      filters.push(`decision = $${params.length}`);
    }
    // Overfetch by one to learn whether another page exists without a second COUNT query.
    params.push(limit + 1);

    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM audit_events
        WHERE ${filters.join(" AND ")}
        ORDER BY chain_index DESC
        LIMIT $${params.length}`,
      params
    );

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToEvent);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? last.chainIndex : null,
    };
  }

  /** Durable event count, used as the {@link VerifyExpectation} that detects tail deletion. */
  async count(businessId: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::bigint AS n FROM audit_events WHERE business_id = $1`,
      [businessId]
    );
    return Number((rows[0] as { n: string } | undefined)?.n ?? 0);
  }
}
