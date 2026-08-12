import { hasConnect, type Queryable } from "./db";
import { PG_MIGRATIONS } from "./pg-migrations/index";

/**
 * Advisory-lock key for the boot-time migration run. Arbitrary but *stable*: every replica must
 * name the same number or the lock excludes nobody.
 */
export const MIGRATION_LOCK_KEY = 772_071_044;

/**
 * ~5 minutes. Sized for the slowest thing a migration does — an ANN index build over a full
 * knowledge corpus (v45) — not for the fast DDL that most migrations are. A peer that exceeds even
 * this is reported as a timeout and the replica exits; its restart simply queues again, which is a
 * better failure than an indefinite silent boot hang.
 */
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

/**
 * On-boot Postgres migration runner: serialized, transactional, version-tracked, fail-loud.
 *
 * Takes a `Queryable` so the same code runs against `pg.Pool` (prod) and the PGlite test client.
 * `exit` and `log` are injectable for tests (see `env.ts`).
 *
 * The whole run happens on **one** connection under **one** advisory lock. Both matter:
 * `Pool.query` would otherwise spread the lock and the migrations across different connections
 * (making the lock decorative), and without the lock two replicas booting together would race
 * `CREATE TABLE IF NOT EXISTS` and apply the same migration twice.
 */
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
      // Read the version *after* taking the lock, never before: a replica that queued behind a
      // peer must see the work that peer just finished, or it replays every migration itself.
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
  // Single-row table: the sentinel PK + CHECK make a second row impossible, so the version is
  // unambiguous (not enforced by convention alone). `apps/worker` and `apps/integration-worker`
  // gate startup on this shape — extend it, never change it.
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
  // The ledger answers "what ran, when, and how long" — which a single integer cannot. It is
  // deliberately not a checksum of the migration source: the API is esbuild-bundled, so the same
  // migration hashes differently under `tsx` and in the image, and every boot would cry drift.
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer PRIMARY KEY,
      description text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )`
  );
  // A database migrated before the ledger existed has nothing to show. Record one baseline row
  // rather than inventing timestamps for migrations nobody observed.
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

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so such a migration trades
  // atomicity away by declaring `concurrent`. A failure can leave an invalid index behind for an
  // operator to drop — which is why the flag is opt-in and rare, not the default.
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

  // The version bump and the ledger row commit *with* the DDL they describe. Without this a
  // half-applied migration leaves objects behind at an unchanged version, and the next boot
  // replays it onto them.
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
