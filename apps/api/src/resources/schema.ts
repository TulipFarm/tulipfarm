import { createHash } from "node:crypto";
import type { ResourceDoc } from "./repo";

// Re-check type and field names before SQL interpolation and quote them; resources live in their
// own schema, and `x-unique` field names come from Soul-authored YAML, not a trusted constant.

const TYPE_RE = /^[a-z][a-z0-9-]*$/;
const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function assertValidType(type: string): void {
  if (!TYPE_RE.test(type)) {
    throw new Error(`invalid resource type name: ${JSON.stringify(type)}`);
  }
}

export function assertValidFields(fields: readonly string[]): void {
  for (const field of fields) {
    if (!FIELD_RE.test(field)) {
      throw new Error(`invalid unique field name: ${JSON.stringify(field)}`);
    }
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

/** Deterministic, length-safe index name; field names are not embedded (avoids ident limits). */
function uniqueIndexName(type: string, fields: readonly string[]): string {
  const hash = createHash("sha256").update(fields.join(" ")).digest("hex").slice(0, 12);
  return `uniq_${type.replace(/-/g, "_")}_${hash}`;
}

/**
 * Idempotent DDL enforcing one `x-unique` entry: a partial unique index over the named `data`
 * fields, live rows only. A real constraint, unlike `idempotencyKey` — it holds across callers.
 */
export function uniqueIndexSql(type: string, fields: readonly string[]): string {
  assertValidType(type);
  assertValidFields(fields);
  const name = uniqueIndexName(type, fields);
  const expr = fields.map((f) => `(data->>'${f}')`).join(", ");
  return `CREATE UNIQUE INDEX IF NOT EXISTS "${name}" ON ${tableName(type)} (${expr}) WHERE deleted_at IS NULL`;
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
