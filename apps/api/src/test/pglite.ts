import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";

/**
 * In-process Postgres (WASM) for real-SQL migration/repo tests, loaded with the
 * `vector` + `citext` extensions that the greenfield baseline requires, plus `pg_trgm` for the
 * trigram typo-tolerance recall pass (greenfield baseline). The returned instance
 * satisfies `Queryable`, so it drops straight into `runPgMigrations` and the repos.
 */
export function makePglite(): Promise<PGlite> {
  return PGlite.create({ extensions: { vector, citext, pg_trgm } });
}
