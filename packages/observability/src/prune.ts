/** Minimal database surface for the package-owned observability retention operation. */
export interface ObservabilityQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Default raw-event retention window: 90 days. */
export const OBS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** PostgreSQL adapter for deleting expired raw observability events. */
export class PgObservabilityPruner {
  constructor(private readonly database: ObservabilityQueryable) {}

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const result = await this.database.query("DELETE FROM obs_event WHERE ts < $1 RETURNING id", [
      cutoff,
    ]);
    return result.rows.length;
  }
}
