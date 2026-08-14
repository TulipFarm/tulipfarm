import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";

/** In-process Postgres for repo tests, with required `vector`, `citext`, and `pg_trgm`. */
export function makePglite(): Promise<PGlite> {
  return PGlite.create({ extensions: { vector, citext, pg_trgm } });
}
