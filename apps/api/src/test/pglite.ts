import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { runPgMigrations } from "../pg-migrate";

const EXTENSIONS = { vector, citext, pg_trgm };

/** In-process Postgres for repo tests, with required `vector`, `citext`, and `pg_trgm`. */
export function makePglite(): Promise<PGlite> {
  return PGlite.create({ extensions: EXTENSIONS });
}

let migratedSnapshot: Promise<Blob | File> | undefined;

/**
 * A fully migrated database for a single test. Prefer this over `makePglite` + `runPgMigrations`:
 * replaying every migration per test costs ~617ms against ~138ms to restore, and the suite pays
 * that hundreds of times. The snapshot is built once per Vitest worker and kept uncompressed —
 * gzip shrinks it ~8x but adds ~70ms to every restore, the wrong side of this trade.
 *
 * Each call still returns its own database, so isolation is unchanged. Reach for `makePglite` only
 * when the unmigrated schema is the subject, as in `pg-migrate.test.ts`.
 */
export async function makeMigratedPglite(): Promise<PGlite> {
  migratedSnapshot ??= (async () => {
    const database = await makePglite();
    await runPgMigrations(database);
    const snapshot = await database.dumpDataDir("none");
    await database.close();
    return snapshot;
  })();
  return PGlite.create({ extensions: EXTENSIONS, loadDataDir: await migratedSnapshot });
}
