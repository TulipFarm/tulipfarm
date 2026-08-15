import type { Queryable } from "@tulipfarm/storage";

/** One connector's persisted sync state (`knowledge_connectors`). */
export interface ConnectorState {
  name: string;
  enabled: boolean;
  /** Opaque resume position from the connector's last successful `listChanged`. */
  cursor: string | null;
  lastRunAt: Date | null;
  lastError: string | null;
}

export interface ConnectorStateRepo {
  /** Create the row if absent (idempotent registration); never clobbers an existing cursor/enabled. */
  ensure(name: string): Promise<void>;
  get(name: string): Promise<ConnectorState | null>;
  listEnabled(): Promise<ConnectorState[]>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  /** Advance the resume cursor after a successful sync pass. */
  setCursor(name: string, cursor: string | null): Promise<void>;
  /** Stamp a successful run: set last_run_at = now, clear last_error. */
  recordRun(name: string): Promise<void>;
  /** Stamp a failed run: set last_run_at = now, store the error message. */
  recordError(name: string, error: string): Promise<void>;
}

function rowToState(row: Record<string, unknown>): ConnectorState {
  return {
    name: row.name as string,
    enabled: row.enabled as boolean,
    cursor: (row.cursor as string | null) ?? null,
    lastRunAt: (row.last_run_at as Date | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
  };
}

export class PgConnectorStateRepo implements ConnectorStateRepo {
  constructor(private readonly q: Queryable) {}

  async ensure(name: string): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_connectors (name, enabled, created_at, updated_at)
       VALUES ($1, false, now(), now())
       ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }

  async get(name: string): Promise<ConnectorState | null> {
    const { rows } = await this.q.query("SELECT * FROM knowledge_connectors WHERE name = $1", [
      name,
    ]);
    return rows[0] ? rowToState(rows[0] as Record<string, unknown>) : null;
  }

  async listEnabled(): Promise<ConnectorState[]> {
    const { rows } = await this.q.query(
      "SELECT * FROM knowledge_connectors WHERE enabled = true ORDER BY name"
    );
    return rows.map((r) => rowToState(r as Record<string, unknown>));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.q.query(
      "UPDATE knowledge_connectors SET enabled = $2, updated_at = now() WHERE name = $1",
      [name, enabled]
    );
  }

  async setCursor(name: string, cursor: string | null): Promise<void> {
    await this.q.query(
      "UPDATE knowledge_connectors SET cursor = $2, updated_at = now() WHERE name = $1",
      [name, cursor]
    );
  }

  async recordRun(name: string): Promise<void> {
    await this.q.query(
      "UPDATE knowledge_connectors SET last_run_at = now(), last_error = NULL, updated_at = now() WHERE name = $1",
      [name]
    );
  }

  async recordError(name: string, error: string): Promise<void> {
    await this.q.query(
      "UPDATE knowledge_connectors SET last_run_at = now(), last_error = $2, updated_at = now() WHERE name = $1",
      [name, error]
    );
  }
}
