import { randomUUID } from "node:crypto";
import { type PaginatedResult, toPage } from "../pg/pagination";
import { withTransaction } from "../pg/transaction-helpers";
import type { Queryable } from "../ports/transaction";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_RE = /^[a-z][a-z0-9-]*$/;

export interface ResourceDoc {
  _id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  [key: string]: unknown;
}

export type HistoryOp = "create" | "update" | "delete";
export interface ResourceHistoryDoc {
  _id: string;
  resourceId: string;
  operation: HistoryOp;
  snapshot: ResourceDoc;
  at: Date;
}
export interface ListOpts {
  limit: number;
  after?: { createdAt: Date; _id: string };
  includeDeleted?: boolean;
}
export interface SearchOpts extends ListOpts {
  filter?: Record<string, unknown>;
}
export type ResourceMutationKind = "create" | "update" | "delete";
export interface ResourceSideEffect {
  readonly kind: ResourceMutationKind;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly record: Record<string, unknown>;
  readonly actorId?: string;
  readonly afterHook?: { readonly source: string; readonly hash?: string };
}
export interface ResourceRepo {
  insert(doc: ResourceDoc, sideEffect?: ResourceSideEffect): Promise<void>;
  createIdempotently?(
    doc: ResourceDoc,
    idempotencyKey: string,
    sideEffect: ResourceSideEffect
  ): Promise<{ readonly created: boolean; readonly doc: ResourceDoc }>;
  findById(id: string): Promise<ResourceDoc | null>;
  list(opts: ListOpts): Promise<PaginatedResult<ResourceDoc>>;
  search(opts: SearchOpts): Promise<PaginatedResult<ResourceDoc>>;
  replaceOne(
    id: string,
    expected: number,
    doc: ResourceDoc,
    op: HistoryOp,
    sideEffect?: ResourceSideEffect
  ): Promise<boolean>;
  readonly durableSideEffects?: true;
}
export interface ResourceRepoFactory {
  forType(type: string): ResourceRepo;
}
export const RESOURCE_SIDE_EFFECT_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS resource_create_requests (resource_type text NOT NULL, caller_id text NOT NULL, idempotency_key text NOT NULL, resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (resource_type, caller_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS resource_side_effect_outbox (id uuid PRIMARY KEY, effect jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'quarantined')), attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), lease_owner text, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, CHECK ((status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR status <> 'leased'))`,
  `CREATE INDEX IF NOT EXISTS resource_side_effect_outbox_claim_idx ON resource_side_effect_outbox (status, lease_until, created_at)`,
] as const;
export class ResourceSideEffectOutbox {
  constructor(private readonly database: Queryable) {}
  async claim(
    owner: string,
    limit: number,
    leaseMs: number
  ): Promise<readonly { id: string; effect: ResourceSideEffect }[]> {
    return withTransaction(
      this.database,
      async (tx) =>
        (
          await tx.query<{ id: string; effect: ResourceSideEffect }>(
            `WITH candidates AS (SELECT id FROM resource_side_effect_outbox WHERE status = 'pending' OR (status = 'leased' AND lease_until <= now()) ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE resource_side_effect_outbox AS outbox SET status = 'leased', attempts = outbox.attempts + 1, lease_owner = $2, lease_until = now() + ($3 * interval '1 millisecond') FROM candidates WHERE outbox.id = candidates.id RETURNING outbox.id, outbox.effect`,
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

function tableName(type: string): string {
  if (!TYPE_RE.test(type)) throw new Error(`invalid resource type name: ${JSON.stringify(type)}`);
  return `resources."${type}"`;
}
function historyTableName(type: string): string {
  return `${tableName(type).slice(0, -1)}_history"`;
}
function rowToResourceDoc(row: Record<string, unknown>): ResourceDoc {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const deletedAt = row.deleted_at as Date | null;
  return {
    ...data,
    _id: row.id as string,
    version: Number(row.version),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    ...(deletedAt == null ? {} : { deletedAt }),
  };
}
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

export class PgResourceRepo implements ResourceRepo {
  readonly durableSideEffects = true as const;
  private readonly table: string;
  private readonly historyTable: string;
  constructor(
    private readonly q: Queryable,
    private readonly type: string
  ) {
    this.table = tableName(type);
    this.historyTable = historyTableName(type);
  }
  async insert(doc: ResourceDoc, sideEffect?: ResourceSideEffect): Promise<void> {
    const { _id, version, createdAt, updatedAt, deletedAt, ...data } = doc;
    await withTransaction(this.q, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.table} (id, version, created_at, updated_at, deleted_at, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [_id, version, createdAt, updatedAt, deletedAt ?? null, JSON.stringify(data)]
      );
      await this.appendHistory(tx, historyEntry(_id, "create", doc));
      if (sideEffect) await writeResourceSideEffect(tx, randomUUID(), sideEffect);
    });
  }
  async createIdempotently(
    doc: ResourceDoc,
    idempotencyKey: string,
    sideEffect: ResourceSideEffect
  ): Promise<{ readonly created: boolean; readonly doc: ResourceDoc }> {
    return withTransaction(this.q, async (tx) => {
      const claimed = await tx.query<{ resource_id: string }>(
        `INSERT INTO resource_create_requests (resource_type, caller_id, idempotency_key, resource_id) VALUES ($1, $2, $3, $4) ON CONFLICT (resource_type, caller_id, idempotency_key) DO NOTHING RETURNING resource_id`,
        [this.type, sideEffect.actorId ?? "system", idempotencyKey, doc._id]
      );
      if (claimed.rows.length === 0) {
        const existing = await tx.query(
          `SELECT id, version, created_at, updated_at, deleted_at, data FROM ${this.table} WHERE id = (SELECT resource_id FROM resource_create_requests WHERE resource_type = $1 AND caller_id = $2 AND idempotency_key = $3)`,
          [this.type, sideEffect.actorId ?? "system", idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row) throw new Error("resource_idempotency_conflict_without_record");
        return { created: false, doc: rowToResourceDoc(row) };
      }
      const { _id, version, createdAt, updatedAt, deletedAt, ...data } = doc;
      await tx.query(
        `INSERT INTO ${this.table} (id, version, created_at, updated_at, deleted_at, data) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [_id, version, createdAt, updatedAt, deletedAt ?? null, JSON.stringify(data)]
      );
      await this.appendHistory(tx, historyEntry(_id, "create", doc));
      await writeResourceSideEffect(tx, randomUUID(), sideEffect);
      return { created: true, doc };
    });
  }
  async findById(id: string): Promise<ResourceDoc | null> {
    if (!UUID_RE.test(id)) return null;
    const { rows } = await this.q.query(
      `SELECT id, version, created_at, updated_at, deleted_at, data FROM ${this.table} WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToResourceDoc(rows[0]) : null;
  }
  async list(opts: ListOpts): Promise<PaginatedResult<ResourceDoc>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeDeleted) conditions.push("deleted_at IS NULL");
    if (opts.after) {
      params.push(opts.after.createdAt, opts.after._id);
      conditions.push(`(created_at, id) > ($${params.length - 1}, $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT id, version, created_at, updated_at, deleted_at, data FROM ${this.table} ${where} ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToResourceDoc), opts.limit);
  }
  async search(opts: SearchOpts): Promise<PaginatedResult<ResourceDoc>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeDeleted) conditions.push("deleted_at IS NULL");
    if (opts.after) {
      params.push(opts.after.createdAt, opts.after._id);
      conditions.push(`(created_at, id) > ($${params.length - 1}, $${params.length})`);
    }
    if (opts.filter && Object.keys(opts.filter).length) {
      params.push(JSON.stringify(opts.filter));
      conditions.push(`data @> $${params.length}::jsonb`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT id, version, created_at, updated_at, deleted_at, data FROM ${this.table} ${where} ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToResourceDoc), opts.limit);
  }
  async replaceOne(
    id: string,
    expected: number,
    doc: ResourceDoc,
    op: HistoryOp,
    sideEffect?: ResourceSideEffect
  ): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const { _id, version, createdAt, updatedAt, deletedAt, ...data } = doc;
    return withTransaction(this.q, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE ${this.table} SET version = $1, created_at = $2, updated_at = $3, deleted_at = $4, data = $5::jsonb WHERE id = $6 AND version = $7 RETURNING id`,
        [version, createdAt, updatedAt, deletedAt ?? null, JSON.stringify(data), id, expected]
      );
      if (rows.length !== 1) return false;
      await this.appendHistory(tx, historyEntry(id, op, doc));
      if (sideEffect) await writeResourceSideEffect(tx, randomUUID(), sideEffect);
      return true;
    });
  }
  private async appendHistory(tx: Queryable, entry: ResourceHistoryDoc): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.historyTable} (id, resource_id, operation, snapshot, at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [entry._id, entry.resourceId, entry.operation, JSON.stringify(entry.snapshot), entry.at]
    );
  }
}
export class PgResourceRepoFactory implements ResourceRepoFactory {
  constructor(private readonly q: Queryable) {}
  forType(type: string): ResourceRepo {
    return new PgResourceRepo(this.q, type);
  }
}
function historyEntry(
  resourceId: string,
  operation: HistoryOp,
  snapshot: ResourceDoc
): ResourceHistoryDoc {
  return { _id: randomUUID(), resourceId, operation, snapshot, at: new Date() };
}
