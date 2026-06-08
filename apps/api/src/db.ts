import { Pool } from "pg";

let pool: Pool;

/**
 * Minimal query surface shared by `pg.Pool` (prod) and the PGlite test client,
 * so the migration runner and repos run identical SQL in both environments.
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function connectPg(): Promise<Pool> {
  pool = new Pool({ connectionString: process.env.DATABASE_URL as string });
  // Force a connection now so boot fails loud if Postgres is unreachable.
  await pool.query("SELECT 1");
  return pool;
}

export function getPool(): Pool {
  return pool;
}
