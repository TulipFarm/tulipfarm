import { workerData } from "node:worker_threads";
import { pgPoolTuning } from "@tulipfarm/constants";
import { serveHookRequests } from "@tulipfarm/sandbox";
import { Pool } from "pg";
import { rowToResourceDoc, tableName } from "../resources/schema";

/** API hook sandbox port: the isolate gets only one read-only resource lookup. */

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    // User-authored hooks use the restricted role when present; keep the pool small and bounded.
    const roleOptions = workerData.roleOptions as string | undefined;
    pool = new Pool({
      connectionString: workerData.connectionString as string,
      ...pgPoolTuning({ max: 2 }),
      ...(roleOptions === undefined ? {} : { options: roleOptions }),
    });
  }
  return pool;
}

function docToRecord(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = doc as { _id: string } & Record<string, unknown>;
  const out: Record<string, unknown> = { id: _id, ...rest };
  if (out.createdAt instanceof Date) out.createdAt = out.createdAt.toISOString();
  if (out.updatedAt instanceof Date) out.updatedAt = out.updatedAt.toISOString();
  if (out.deletedAt instanceof Date) out.deletedAt = out.deletedAt.toISOString();
  return out;
}

serveHookRequests({
  resourceLookup: async (type, resourceId) => {
    let table: string;
    try {
      table = tableName(type);
    } catch {
      return null; // unknown / invalid resource type
    }
    const { rows } = await getPool().query<Record<string, unknown>>(
      `SELECT id, version, created_at, updated_at, deleted_at, data
       FROM ${table} WHERE id = $1 AND deleted_at IS NULL`,
      [resourceId]
    );
    if (!rows[0]) return null;
    return docToRecord(rowToResourceDoc(rows[0]));
  },
  shutdown: async () => {
    if (pool) await pool.end().catch(() => {});
  },
});
