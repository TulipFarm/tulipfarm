import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { runPgMigrations } from "../pg-migrate";
import { PG_MIGRATIONS } from "../pg-migrations";

const EXTENSIONS = { vector, citext, pg_trgm };

/** In-process Postgres for repo tests, with required `vector`, `citext`, and `pg_trgm`. */
export function makePglite(): Promise<PGlite> {
  return PGlite.create({ extensions: EXTENSIONS });
}

const migratedSnapshots = new Map<number, Promise<Blob | File>>();
const latestVersion = Math.max(...PG_MIGRATIONS.map(({ version }) => version));

/**
 * An isolated database migrated through `version` (latest by default). Historical snapshots
 * contain the real migration prefix and a pre-ledger version marker, never rewound latest DDL.
 * Prefer this over `makePglite` + `runPgMigrations`:
 * replaying every migration per test costs ~617ms against ~138ms to restore, and the suite pays
 * that hundreds of times. Each version is built once per Vitest worker and kept uncompressed —
 * gzip shrinks it ~8x but adds ~70ms to every restore, the wrong side of this trade.
 *
 * Each call still returns its own database, so isolation is unchanged. Reach for `makePglite` only
 * when the unmigrated schema is the subject, as in `pg-migrate.test.ts`.
 */
export async function makeMigratedPglite(version = latestVersion): Promise<PGlite> {
  if (version !== 0 && !PG_MIGRATIONS.some((migration) => migration.version === version)) {
    throw new RangeError(`Unknown migration version: ${version}`);
  }
  let snapshot = migratedSnapshots.get(version);
  if (!snapshot) {
    snapshot = buildSnapshot(version).catch((error: unknown) => {
      migratedSnapshots.delete(version);
      throw error;
    });
    migratedSnapshots.set(version, snapshot);
  }
  return PGlite.create({ extensions: EXTENSIONS, loadDataDir: await snapshot });
}

async function buildSnapshot(version: number): Promise<Blob | File> {
  const database = await makePglite();
  try {
    if (version === latestVersion) {
      await runPgMigrations(database, (code) => {
        throw new Error(`Snapshot migration exited with ${code}`);
      });
    } else {
      for (const migration of PG_MIGRATIONS.filter((migration) => migration.version <= version)) {
        if (migration.concurrent) await migration.up(database);
        else await database.transaction((tx) => migration.up(tx));
      }
      await database.exec(`
        CREATE TABLE schema_version (
          id boolean PRIMARY KEY DEFAULT true CHECK (id),
          version integer NOT NULL
        );
      `);
      await database.query("INSERT INTO schema_version (id, version) VALUES (true, $1)", [version]);
    }
    return await database.dumpDataDir("none");
  } finally {
    await database.close();
  }
}
