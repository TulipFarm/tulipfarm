import type { FlagSubjectResolver } from '@tulipfarm/observability';

type Queryable = { query(sql: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

/**
 * Reads flag targeting attributes from the API's own database: the user's email and the
 * workspace's slug, name and creation time. Flag evaluation never grants access, so membership is
 * checked by the caller before a workspace is passed in.
 */
export function apiFlagSubjects(pool: Queryable): FlagSubjectResolver {
  return async ({ userId, workspaceId }) => {
    const [user, workspace] = await Promise.all([
      userId ? pool.query('SELECT email FROM app.users WHERE id = $1', [userId]) : undefined,
      workspaceId
        ? pool.query('SELECT slug, name, created_at FROM app.workspaces WHERE id = $1', [workspaceId])
        : undefined,
    ]);
    const userRow = user?.rows[0];
    const workspaceRow = workspace?.rows[0];
    const createdAt = workspaceRow?.created_at;
    return {
      ...(userRow && { user: { email: text(userRow.email) } }),
      ...(workspaceRow && {
        workspace: {
          slug: text(workspaceRow.slug),
          name: text(workspaceRow.name),
          createdAt: createdAt instanceof Date ? createdAt.toISOString() : text(createdAt),
        },
      }),
    };
  };
}
