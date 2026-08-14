import { hasConnect, type Queryable } from "./db";
import { PG_MIGRATIONS } from "./pg-migrations/index";

/** Stable advisory-lock key shared by every replica. */
export const MIGRATION_LOCK_KEY = 772_071_044;

/** Five-minute lock timeout covers slow ANN index builds without hiding deadlocks. */
const DEFAULT_LOCK_ATTEMPTS = 300;
const DEFAULT_LOCK_DELAY_MS = 1_000;

export interface MigrationRunOptions {
  /** Bounded wait for the lock. Exhausting it fails boot loudly rather than hanging it forever. */
  readonly lockAttempts?: number;
  readonly lockDelayMs?: number;
  /** Test seam. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MigrationLockTimeoutError extends Error {
  readonly name = "MigrationLockTimeoutError";
}

class MigrationFailedError extends Error {
  readonly name = "MigrationFailedError";
  readonly version: number;

  constructor(version: number, cause: unknown) {
    super(`Postgres migration v${version} failed: ${describe(cause)}`, { cause });
    this.version = version;
  }
}

/** Serialized, transactional, version-tracked migration runner. */
export async function runPgMigrations(
  q: Queryable,
  exit: (code: number) => void = process.exit,
  log: (msg: string) => void = console.log,
  options: MigrationRunOptions = {}
): Promise<void> {
  const session = hasConnect(q) ? await q.connect() : null;
  const db: Queryable = session ?? q;

  try {
    await withMigrationLock(db, options, async () => {
      await ensureVersionTables(db);
      // Read version after the lock, so queued replicas see completed peer work.
      const currentVersion = await readSchemaVersion(db);
      const pending = PG_MIGRATIONS.filter((m) => m.version > currentVersion).sort(
        (a, b) => a.version - b.version
      );
      for (const migration of pending) {
        await applyMigration(db, migration, log);
      }
    });
  } catch (error) {
    console.error(`❌ ${describe(error)}`);
    exit(1);
    return;
  } finally {
    session?.release();
  }
}

/** Serializes the run across replicas. Session-scoped, so it also dies with a crashed process. */
async function withMigrationLock(
  db: Queryable,
  options: MigrationRunOptions,
  operation: () => Promise<void>
): Promise<void> {
  const attempts = options.lockAttempts ?? DEFAULT_LOCK_ATTEMPTS;
  const delayMs = options.lockDelayMs ?? DEFAULT_LOCK_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt += 1) {
    const { rows } = await db.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
      MIGRATION_LOCK_KEY,
    ]);
    if (rows[0]?.locked === true) break;
    if (attempt >= attempts) {
      throw new MigrationLockTimeoutError(
        `another instance has held the Postgres migration lock for ${(attempts * delayMs) / 1000}s — ` +
          "it is still migrating, or it died holding an open transaction"
      );
    }
    await sleep(delayMs);
  }

  try {
    await operation();
  } finally {
    // The lock dies with the session regardless, so a failure here must never mask the real error.
    await db.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]).catch(() => {});
  }
}

async function ensureVersionTables(db: Queryable): Promise<void> {
  // Single sentinel row keeps version unambiguous; worker apps depend on this shape.
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_version (
      id      boolean PRIMARY KEY DEFAULT true,
      version integer NOT NULL,
      CONSTRAINT schema_version_single_row CHECK (id)
    )`
  );
  await db.query(
    "INSERT INTO schema_version (id, version) VALUES (true, 0) ON CONFLICT (id) DO NOTHING"
  );
  // Ledger records observed runs, not source checksums that differ after bundling.
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer PRIMARY KEY,
      description text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )`
  );
  // For pre-ledger databases, record one honest baseline row.
  await db.query(
    `INSERT INTO schema_migrations (version, description, duration_ms)
     SELECT version, 'pre-ledger baseline', NULL
       FROM schema_version
      WHERE id = true
        AND version > 0
        AND NOT EXISTS (SELECT 1 FROM schema_migrations)
     ON CONFLICT (version) DO NOTHING`
  );
}

async function readSchemaVersion(db: Queryable): Promise<number> {
  const existing = await db.query("SELECT version FROM schema_version WHERE id = true");
  return Number((existing.rows[0] as { version: number }).version);
}

async function applyMigration(
  db: Queryable,
  migration: (typeof PG_MIGRATIONS)[number],
  log: (msg: string) => void
): Promise<void> {
  log(`🚀 Running Postgres migration v${migration.version}: ${migration.description}`);
  const startedAt = Date.now();

  // Concurrent indexes trade atomicity away and can leave invalid indexes on failure.
  if (migration.concurrent) {
    try {
      await migration.up(db);
      await recordApplied(db, migration, Date.now() - startedAt);
    } catch (error) {
      throw new MigrationFailedError(migration.version, error);
    }
    log(`✅ Postgres migration v${migration.version} applied`);
    return;
  }

  // Version and ledger row commit with their DDL, so failed migrations replay cleanly.
  await db.query("BEGIN");
  try {
    await migration.up(db);
    await recordApplied(db, migration, Date.now() - startedAt);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw new MigrationFailedError(migration.version, error);
  }
  log(`✅ Postgres migration v${migration.version} applied`);
}

async function recordApplied(
  db: Queryable,
  migration: (typeof PG_MIGRATIONS)[number],
  durationMs: number
): Promise<void> {
  await db.query("UPDATE schema_version SET version = $1 WHERE id = true", [migration.version]);
  await db.query(
    `INSERT INTO schema_migrations (version, description, duration_ms)
     VALUES ($1, $2, $3)
     ON CONFLICT (version) DO UPDATE
       SET description = EXCLUDED.description,
           applied_at  = now(),
           duration_ms = EXCLUDED.duration_ms`,
    [migration.version, migration.description, durationMs]
  );
}
