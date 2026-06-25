import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite-pgvector";

/**
 * In-process Postgres (WASM) for real-SQL migration/repo tests, loaded with the
 * `vector` + `citext` extensions that `001_init` requires. The returned instance
 * satisfies `Queryable`, so it drops straight into `runPgMigrations` and the repos.
 */
export function makePglite(): Promise<PGlite> {
  return PGlite.create({ extensions: { vector, citext } });
}
