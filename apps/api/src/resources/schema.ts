import type { ResourceDoc } from "./repo";

// Re-check type names before SQL interpolation and quote them; resources live in their own schema.

const TYPE_RE = /^[a-z][a-z0-9-]*$/;

export function assertValidType(type: string): void {
  if (!TYPE_RE.test(type)) {
    throw new Error(`invalid resource type name: ${JSON.stringify(type)}`);
  }
}

export function tableName(type: string): string {
  assertValidType(type);
  return `resources."${type}"`;
}

export function historyTableName(type: string): string {
  assertValidType(type);
  return `resources."${type}_history"`;
}

/** Idempotent per-type table DDL (D4). Single statement for PGlite portability. */
export function createResourceTableSql(type: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName(type)} (
    id          uuid PRIMARY KEY,
    version     integer NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,
    deleted_at  timestamptz,
    data        jsonb NOT NULL
  )`;
}

export function createHistoryTableSql(type: string): string {
  return `CREATE TABLE IF NOT EXISTS ${historyTableName(type)} (
    id          uuid PRIMARY KEY,
    resource_id uuid NOT NULL,
    operation   text NOT NULL,
    snapshot    jsonb NOT NULL,
    at          timestamptz NOT NULL
  )`;
}

/** Spread data first so row system columns remain authoritative. */
export function rowToResourceDoc(row: Record<string, unknown>): ResourceDoc {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const deletedAt = row.deleted_at as Date | null;
  return {
    ...data,
    _id: row.id as string,
    version: Number(row.version),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    ...(deletedAt != null ? { deletedAt } : {}),
  };
}
