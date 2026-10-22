import { escapeIdentifier, type Client } from 'pg';
import { z } from 'zod';

const relationSchema = z.object({ schema: z.string(), name: z.string(), kind: z.string() });
const countSchema = z.object({ rows: z.string().regex(/^\d+$/) });

export async function workspaceStorageInventory(client: Client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(
      "SET LOCAL row_security = off; SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '5s'",
    );
    const relations = z.array(relationSchema).parse(
      (
        await client.query(`
      SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      ORDER BY n.nspname, c.relname`)
      ).rows,
    );
    const tables = [];
    for (const relation of relations) {
      if (!['r', 'p'].includes(relation.kind)) {
        tables.push({ ...relation, rows: null });
        continue;
      }
      const count = countSchema.parse(
        (
          await client.query(
            `SELECT count(*)::text AS rows FROM ${escapeIdentifier(relation.schema)}.${escapeIdentifier(relation.name)}`,
          )
        ).rows[0],
      );
      tables.push({ ...relation, rows: count.rows });
    }
    const columns = await client.query(`SELECT n.nspname AS table_schema, c.relname AS table_name,
        a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY n.nspname, c.relname, a.attnum`);
    const workspaces = relations.some(row => row.schema === 'app' && row.name === 'workspaces')
      ? (
          await client.query(`SELECT count(*)::text AS total,
          count(*) FILTER (WHERE ready_at IS NOT NULL)::text AS ready,
          count(*) FILTER (WHERE soul_commit IS NOT NULL AND soul_bucket IS NOT NULL AND soul_key IS NOT NULL)::text AS soul_references,
          count(*) FILTER (WHERE soul_key = 'workspaces/' || id::text || '/soul/initial.bundle')::text AS standard_initial_keys,
          count(*) FILTER (WHERE soul_bucket = 'tulipfarm-cloud-soul-production')::text AS production_bucket_references
        FROM app.workspaces`)
        ).rows[0]
      : null;
    const memberships = relations.some(row => row.schema === 'app' && row.name === 'workspace_memberships')
      ? (
          await client.query(`SELECT CASE WHEN role IN ('owner', 'admin', 'member') THEN role ELSE 'unsupported' END AS role,
          count(*)::text AS rows FROM app.workspace_memberships GROUP BY 1 ORDER BY 1`)
        ).rows
      : [];
    await client.query('COMMIT');
    return { tables, columns: columns.rows, workspaces, memberships };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
