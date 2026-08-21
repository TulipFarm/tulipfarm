import { randomUUID } from "node:crypto";
import type { CounterFn } from "@tulipfarm/schema";
import { type PaginatedResult, toPage, withTransaction } from "@tulipfarm/storage";
import type { Queryable } from "../db";
import { historyTableName, rowToResourceDoc, tableName } from "./schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Every mutation also writes the Record's history snapshot, and the two must land together: a
 * committed Record with no history entry is an audit gap no later write can repair.
 */
export interface ResourceRepo {
  insert(doc: ResourceDoc): Promise<void>;
  findById(id: string): Promise<ResourceDoc | null>;
  list(opts: ListOpts): Promise<PaginatedResult<ResourceDoc>>;
  search(opts: SearchOpts): Promise<PaginatedResult<ResourceDoc>>;
  replaceOne(id: string, expected: number, doc: ResourceDoc, op: HistoryOp): Promise<boolean>;
}

/** Builds a `ResourceRepo` bound to a resource type's table (per-request, dynamic type). */
export interface ResourceRepoFactory {
  forType(type: string): ResourceRepo;
}

/** Display-id counter source (yields a `@tulipfarm/schema` `CounterFn`). */
export interface CounterStore {
  makeCounterFn(): CounterFn;
}

/** Resource repo: typed system columns plus schema-driven `data jsonb`; tables pre-exist. */
export class PgResourceRepo implements ResourceRepo {
  private readonly table: string;
  private readonly historyTable: string;

  constructor(
    private readonly q: Queryable,
    type: string
  ) {
    this.table = tableName(type);
    this.historyTable = historyTableName(type);
  }

  async insert(doc: ResourceDoc): Promise<void> {
    const { _id, version, createdAt, updatedAt, deletedAt, ...data } = doc;
    await withTransaction(this.q, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.table} (id, version, created_at, updated_at, deleted_at, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [_id, version, createdAt, updatedAt, deletedAt ?? null, JSON.stringify(data)]
      );
      await this.appendHistory(tx, historyEntry(_id, "create", doc));
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
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT id, version, created_at, updated_at, deleted_at, data FROM ${this.table}
       ${where} ORDER BY created_at, id LIMIT $${params.length}`,
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
    if (opts.filter && Object.keys(opts.filter).length > 0) {
      params.push(JSON.stringify(opts.filter));
      conditions.push(`data @> $${params.length}::jsonb`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT id, version, created_at, updated_at, deleted_at, data FROM ${this.table}
       ${where} ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToResourceDoc), opts.limit);
  }

  async replaceOne(
    id: string,
    expected: number,
    doc: ResourceDoc,
    op: HistoryOp
  ): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const { _id, version, createdAt, updatedAt, deletedAt, ...data } = doc;
    return withTransaction(this.q, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE ${this.table}
         SET version = $1, created_at = $2, updated_at = $3, deleted_at = $4, data = $5::jsonb
         WHERE id = $6 AND version = $7
         RETURNING id`,
        [version, createdAt, updatedAt, deletedAt ?? null, JSON.stringify(data), id, expected]
      );
      if (rows.length !== 1) return false;
      await this.appendHistory(tx, historyEntry(id, op, doc));
      return true;
    });
  }

  private async appendHistory(tx: Queryable, entry: ResourceHistoryDoc): Promise<void> {
    await tx.query(
      `INSERT INTO ${this.historyTable} (id, resource_id, operation, snapshot, at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
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

export class PgCounterStore implements CounterStore {
  constructor(private readonly q: Queryable) {}

  private async increment(type: string): Promise<number> {
    const { rows } = await this.q.query(
      `INSERT INTO counters (type, seq) VALUES ($1, 1)
       ON CONFLICT (type) DO UPDATE SET seq = counters.seq + 1
       RETURNING seq`,
      [type]
    );
    return Number((rows[0] as { seq: number | string }).seq);
  }

  makeCounterFn(): CounterFn {
    return (type: string) => this.increment(type);
  }
}

export function toApiRecord(doc: ResourceDoc): Record<string, unknown> {
  const { _id, ...rest } = doc;
  return {
    id: _id,
    ...rest,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
    ...(doc.deletedAt != null
      ? { deletedAt: doc.deletedAt instanceof Date ? doc.deletedAt.toISOString() : doc.deletedAt }
      : {}),
  };
}

function historyEntry(resourceId: string, operation: HistoryOp, snapshot: ResourceDoc) {
  return { _id: randomUUID(), resourceId, operation, snapshot, at: new Date() };
}
