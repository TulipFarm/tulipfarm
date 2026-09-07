import { createHash } from "node:crypto";
import type { ResourceDoc } from "./repo";

// Re-check type and field names before SQL interpolation and quote them; resources live in their
// own schema, and `x-unique` field names come from Soul-authored YAML, not a trusted constant.

const TYPE_RE = /^[a-z][a-z0-9-]*$/;
const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const POSTGRES_IDENTIFIER_BYTES = 63;
const UNIQUE_FIELD_HASH_LENGTH = 12;
export const MAX_RESOURCE_TYPE_NAME_LENGTH = POSTGRES_IDENTIFIER_BYTES - "_history".length;

export function assertValidType(type: string): void {
  if (!isValidResourceTypeSlug(type)) {
    throw new Error(`invalid resource type name: ${JSON.stringify(type)}`);
  }
}

export function isValidResourceTypeName(type: string): boolean {
  return isValidResourceTypeSlug(type) && Buffer.byteLength(type) <= MAX_RESOURCE_TYPE_NAME_LENGTH;
}

export function isValidResourceTypeSlug(type: string): boolean {
  return TYPE_RE.test(type);
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
export function uniqueIndexPrefix(type: string): string {
  assertValidType(type);
  const slug = type.replace(/-/g, "_");
  const prefix = `uniq_${slug}_`;
  const maxPrefixLength = POSTGRES_IDENTIFIER_BYTES - UNIQUE_FIELD_HASH_LENGTH;
  if (Buffer.byteLength(prefix) <= maxPrefixLength) return prefix;
  const typeHash = createHash("sha256").update(type).digest("hex").slice(0, 8);
  const suffix = `_${typeHash}_`;
  const maxSlugLength = maxPrefixLength - "uniq_".length - suffix.length;
  return `uniq_${slug.slice(0, maxSlugLength)}${suffix}`;
}

export function uniqueIndexName(type: string, fields: readonly string[]): string {
  assertValidFields(fields);
  const hash = createHash("sha256")
    .update(fields.join(" "))
    .digest("hex")
    .slice(0, UNIQUE_FIELD_HASH_LENGTH);
  return `${uniqueIndexPrefix(type)}${hash}`;
}

export function isOwnedUniqueIndexName(type: string, name: string): boolean {
  const currentPrefix = uniqueIndexPrefix(type);
  if (name.startsWith(currentPrefix) && /^[a-f0-9]{12}$/.test(name.slice(currentPrefix.length))) {
    return true;
  }
  const legacyPrefix = `uniq_${type.replace(/-/g, "_")}_`;
  if (legacyPrefix.length > POSTGRES_IDENTIFIER_BYTES) {
    return name === legacyPrefix.slice(0, POSTGRES_IDENTIFIER_BYTES);
  }
  const suffix = name.slice(legacyPrefix.length);
  return (
    name.startsWith(legacyPrefix) &&
    suffix.length ===
      Math.min(UNIQUE_FIELD_HASH_LENGTH, POSTGRES_IDENTIFIER_BYTES - legacyPrefix.length) &&
    /^[a-f0-9]*$/.test(suffix)
  );
}

export function dropOwnedUniqueIndexSql(type: string, name: string): string {
  if (!isOwnedUniqueIndexName(type, name) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`invalid owned unique index name: ${JSON.stringify(name)}`);
  }
  return `DROP INDEX resources."${name}"`;
}

/**
 * DDL enforcing one `x-unique` entry: a partial unique index over the named `data` fields, live
 * rows only. A real constraint, unlike `idempotencyKey` — it holds across callers.
 */
export function uniqueIndexSql(type: string, fields: readonly string[]): string {
  assertValidType(type);
  assertValidFields(fields);
  const name = uniqueIndexName(type, fields);
  const expr = fields.map((f) => `(data->>'${f}')`).join(", ");
  return `CREATE UNIQUE INDEX "${name}" ON ${tableName(type)} (${expr}) WHERE deleted_at IS NULL`;
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
