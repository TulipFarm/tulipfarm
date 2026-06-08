import type { Queryable } from "./db";
import { PG_MIGRATIONS } from "./pg-migrations/index";

/**
 * On-boot Postgres migration runner: version-tracked, fail-loud, idempotent.
 * Takes a `Queryable` so the same code runs against `pg.Pool` (prod) and the
 * PGlite test client. `exit` is injectable for tests (see `env.ts`).
 */
export async function runPgMigrations(
  q: Queryable,
  exit: (code: number) => void = process.exit,
  log: (msg: string) => void = console.log
): Promise<void> {
  // Single-row table: the sentinel PK + CHECK make a second row impossible, so the
  // version is unambiguous (not enforced by convention alone).
  await q.query(
    `CREATE TABLE IF NOT EXISTS schema_version (
      id      boolean PRIMARY KEY DEFAULT true,
      version integer NOT NULL,
      CONSTRAINT schema_version_single_row CHECK (id)
    )`
  );
  await q.query(
    "INSERT INTO schema_version (id, version) VALUES (true, 0) ON CONFLICT (id) DO NOTHING"
  );

  const existing = await q.query("SELECT version FROM schema_version WHERE id = true");
  const currentVersion = Number((existing.rows[0] as { version: number }).version);

  const pending = PG_MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );

  for (const migration of pending) {
    log(`🚀 Running Postgres migration v${migration.version}: ${migration.description}`);
    try {
      await migration.up(q);
      await q.query("UPDATE schema_version SET version = $1 WHERE id = true", [migration.version]);
      log(`✅ Postgres migration v${migration.version} applied`);
    } catch (error) {
      console.error(
        `❌ Postgres migration v${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      exit(1);
      return;
    }
  }
}
