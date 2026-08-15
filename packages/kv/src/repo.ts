import type { Queryable } from "@tulipfarm/storage";
import { KV_NAME_RE, MAX_KEY_CHARS, MAX_NAMESPACE_CHARS } from "./limits";

export type KvScope = "system" | "user" | "agent";

/** Scoped KV entry; `ownerId` is null only for business scope. */
export interface KvEntry {
  scope: KvScope;
  ownerId?: string;
  namespace: string;
  key: string;
  value: unknown;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class InvalidKvEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKvEntryError";
  }
}

/** The '' sentinel standing in for "no owner" (scope='system') in the composite primary key. */
const SYSTEM_OWNER = "";

/** Live-row filter: NULL expiry never expires; otherwise it must be in the future. */
const NOT_EXPIRED = "(expires_at IS NULL OR expires_at > now())";

/** Write-time structural invariants no row may break. */
export function assertValidAssertion(doc: KvEntry): void {
  ownerColumn(doc.scope, doc.ownerId); // throws if a user/agent entry is missing an owner
  if (doc.scope === "system" && doc.ownerId !== undefined && doc.ownerId !== "") {
    throw new InvalidKvEntryError("system-scoped entry must not carry an ownerId");
  }
  assertName("namespace", doc.namespace, MAX_NAMESPACE_CHARS);
  assertName("key", doc.key, MAX_KEY_CHARS);
}

function assertName(label: string, value: string, max: number): void {
  if (!value) throw new InvalidKvEntryError(`kv ${label} must be non-empty`);
  if (value.length > max) throw new InvalidKvEntryError(`kv ${label} exceeds ${max} characters`);
  if (!KV_NAME_RE.test(value)) {
    throw new InvalidKvEntryError(`kv ${label} has invalid characters: ${JSON.stringify(value)}`);
  }
}

/** scope='system' → '' sentinel; otherwise the required ownerId (throws if absent). */
function ownerColumn(scope: KvScope, ownerId: string | undefined): string {
  if (scope === "system") return SYSTEM_OWNER;
  if (!ownerId) throw new InvalidKvEntryError(`${scope}-scoped operation requires an ownerId`);
  return ownerId;
}

/** Map a row back to KvEntry; pg/PGlite already parse jsonb and timestamptz. */
function rowToEntry(row: Record<string, unknown>): KvEntry {
  const scope = row.scope as KvScope;
  const owner = row.owner_id as string;
  const entry: KvEntry = {
    scope,
    namespace: row.namespace as string,
    key: row.key as string,
    value: row.value,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
  // Non-system rows always carry a real owner (the CHECK forbids ''); system rows expose none.
  if (scope !== "system") entry.ownerId = owner;
  if (row.expires_at != null) entry.expiresAt = row.expires_at as Date;
  return entry;
}

export interface KvRepo {
  /** Last-write-wins upsert on the full composite PK. `created_at` is preserved across updates. */
  upsert(doc: KvEntry): Promise<void>;
  /** Returns null if absent OR expired (lazy expiry). */
  get(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<KvEntry | null>;
  /** True if a live row was removed; false if absent/expired. Idempotent. */
  delete(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<boolean>;
  /** All non-expired entries in a (scope, owner, namespace), key-ordered. */
  listByNamespace(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string
  ): Promise<KvEntry[]>;
}

export class PgKvRepo implements KvRepo {
  constructor(private readonly q: Queryable) {}

  async upsert(doc: KvEntry): Promise<void> {
    assertValidAssertion(doc);
    // Preserve created_at on conflict; only INSERT uses the supplied value.
    await this.q.query(
      `INSERT INTO kv_store (scope, owner_id, namespace, key, value, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (scope, owner_id, namespace, key) DO UPDATE SET
         value = EXCLUDED.value,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at`,
      [
        doc.scope,
        ownerColumn(doc.scope, doc.ownerId),
        doc.namespace,
        doc.key,
        JSON.stringify(doc.value),
        doc.expiresAt ?? null,
        doc.createdAt,
        doc.updatedAt,
      ]
    );
  }

  async get(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<KvEntry | null> {
    const { rows } = await this.q.query(
      `SELECT * FROM kv_store
       WHERE scope = $1 AND owner_id = $2 AND namespace = $3 AND key = $4 AND ${NOT_EXPIRED}`,
      [scope, ownerColumn(scope, ownerId), namespace, key]
    );
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async delete(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string,
    key: string
  ): Promise<boolean> {
    const { rows } = await this.q.query(
      `DELETE FROM kv_store
       WHERE scope = $1 AND owner_id = $2 AND namespace = $3 AND key = $4 AND ${NOT_EXPIRED}
       RETURNING key`,
      [scope, ownerColumn(scope, ownerId), namespace, key]
    );
    return rows.length > 0;
  }

  async listByNamespace(
    scope: KvScope,
    ownerId: string | undefined,
    namespace: string
  ): Promise<KvEntry[]> {
    const { rows } = await this.q.query(
      `SELECT * FROM kv_store
       WHERE scope = $1 AND owner_id = $2 AND namespace = $3 AND ${NOT_EXPIRED}
       ORDER BY key`,
      [scope, ownerColumn(scope, ownerId), namespace]
    );
    return rows.map(rowToEntry);
  }
}
