import type { FlagSubjectResolver } from '@tulipfarm/observability';

type Queryable = { query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/** Reads workspace flag targeting attributes, so the gateway evaluates a workspace flag as the API does. */
export function workspaceFlagSubjects(pool: Queryable): FlagSubjectResolver {
  return async ({ workspaceId }) => {
    if (!workspaceId) return {};
    const { rows } = await pool.query('SELECT slug, name, created_at FROM app.workspaces WHERE id = $1', [workspaceId]);
    const row = rows[0];
    if (!row) return {};
    const createdAt = row.created_at;
    return {
      workspace: {
        slug: text(row.slug),
        name: text(row.name),
        createdAt: createdAt instanceof Date ? createdAt.toISOString() : text(createdAt),
      },
    };
  };
}
