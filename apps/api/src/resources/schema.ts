import type { ResourceDoc } from "./repo";

// Per-type resources live in a dedicated `resources` schema (D9) so `resource:user`
// can't collide with the system `users` table or the `user` reserved word. Type names
// are already constrained to /^[a-z][a-z0-9-]*$/ at POST /resource-types; we re-check
// before ever interpolating one into SQL (defense-in-depth) and double-quote it
// (hyphens require quoting).

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

/**
 * Reconstruct a `ResourceDoc` from a per-type row. System columns are authoritative
 * (spread `data` first so a stray field can never shadow `_id`/`version`/…). pg and
 * PGlite both return `jsonb` as a parsed object and `timestamptz` as a `Date`.
 */
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
