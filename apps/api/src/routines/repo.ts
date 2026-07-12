import type { RoutineDefinition } from "@tulipfarm/schema";
import type { Queryable } from "../db";

export type RunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RoutineRunRow {
  id: string;
  routineSlug: string;
  definitionSnapshot: RoutineDefinition;
  definitionHash: string;
  status: RunStatus;
  currentState: string | null;
  context: Record<string, unknown>;
  trigger: { type: string; payload?: unknown };
  attemptCounts: Record<string, number>;
  wakeAt: Date | null;
  stateDeadline: Date | null;
  approvalId: string | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

const COLS = `id, routine_slug, definition_snapshot, definition_hash, status, current_state,
  context, trigger, attempt_counts, wake_at, state_deadline, approval_id, output, error,
  created_at, updated_at, finished_at`;

function rowToRun(row: Record<string, unknown>): RoutineRunRow {
  return {
    id: row.id as string,
    routineSlug: row.routine_slug as string,
    definitionSnapshot: row.definition_snapshot as RoutineDefinition,
    definitionHash: row.definition_hash as string,
    status: row.status as RunStatus,
    currentState: (row.current_state as string | null) ?? null,
    context: (row.context as Record<string, unknown>) ?? {},
    trigger: row.trigger as { type: string; payload?: unknown },
    attemptCounts: (row.attempt_counts as Record<string, number>) ?? {},
    wakeAt: (row.wake_at as Date | null) ?? null,
    stateDeadline: (row.state_deadline as Date | null) ?? null,
    approvalId: (row.approval_id as string | null) ?? null,
    output: (row.output as Record<string, unknown> | null) ?? null,
    error: (row.error as Record<string, unknown> | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
  };
}

export interface RunJournalEvent {
  runId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * Persistence for routine runs + their journal. Transitions are CAS-guarded on
 * `(status, current_state)` so at-least-once pg-boss deliveries and the sweep can race
 * safely: the losing writer's UPDATE matches zero rows and it backs off.
 */
export class RoutineRunsRepo {
  constructor(private readonly db: Queryable) {}

  async create(run: {
    id: string;
    routineSlug: string;
    definitionSnapshot: RoutineDefinition;
    definitionHash: string;
    currentState: string;
    context: Record<string, unknown>;
    trigger: { type: string; payload?: unknown };
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO routine_runs
         (id, routine_slug, definition_snapshot, definition_hash, status, current_state, context, trigger)
       VALUES ($1, $2, $3::jsonb, $4, 'pending', $5, $6::jsonb, $7::jsonb)`,
      [
        run.id,
        run.routineSlug,
        JSON.stringify(run.definitionSnapshot),
        run.definitionHash,
        run.currentState,
        JSON.stringify(run.context),
        JSON.stringify(run.trigger),
      ]
    );
  }

  async findById(id: string): Promise<RoutineRunRow | null> {
    const { rows } = await this.db.query(`SELECT ${COLS} FROM routine_runs WHERE id = $1`, [id]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async listBySlug(slug: string, limit = 50): Promise<RoutineRunRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLS} FROM routine_runs WHERE routine_slug = $1 ORDER BY created_at DESC LIMIT $2`,
      [slug, limit]
    );
    return rows.map(rowToRun);
  }

  /**
   * CAS transition: applies `patch` only when the row still matches
   * (`expectedStatus`, `expectedState`). Returns false when the guard misses
   * (another delivery already advanced the run).
   */
  async transition(
    id: string,
    expected: { status: RunStatus; currentState?: string | null },
    patch: {
      status?: RunStatus;
      currentState?: string | null;
      context?: Record<string, unknown>;
      attemptCounts?: Record<string, number>;
      wakeAt?: Date | null;
      stateDeadline?: Date | null;
      approvalId?: string | null;
      output?: Record<string, unknown> | null;
      error?: Record<string, unknown> | null;
      finished?: boolean;
    }
  ): Promise<boolean> {
    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [id, expected.status];
    let p = params.length;

    const add = (sql: string, value: unknown) => {
      params.push(value);
      p += 1;
      sets.push(`${sql} = $${p}`);
    };

    if (patch.status !== undefined) add("status", patch.status);
    if (patch.currentState !== undefined) add("current_state", patch.currentState);
    if (patch.context !== undefined) {
      params.push(JSON.stringify(patch.context));
      p += 1;
      sets.push(`context = $${p}::jsonb`);
    }
    if (patch.attemptCounts !== undefined) {
      params.push(JSON.stringify(patch.attemptCounts));
      p += 1;
      sets.push(`attempt_counts = $${p}::jsonb`);
    }
    if (patch.wakeAt !== undefined) add("wake_at", patch.wakeAt);
    if (patch.stateDeadline !== undefined) add("state_deadline", patch.stateDeadline);
    if (patch.approvalId !== undefined) add("approval_id", patch.approvalId);
    if (patch.output !== undefined) {
      params.push(patch.output === null ? null : JSON.stringify(patch.output));
      p += 1;
      sets.push(`output = $${p}::jsonb`);
    }
    if (patch.error !== undefined) {
      params.push(patch.error === null ? null : JSON.stringify(patch.error));
      p += 1;
      sets.push(`error = $${p}::jsonb`);
    }
    if (patch.finished) sets.push("finished_at = now()");

    let guard = "status = $2";
    if (expected.currentState !== undefined) {
      params.push(expected.currentState);
      p += 1;
      guard += ` AND current_state IS NOT DISTINCT FROM $${p}`;
    }

    const { rows } = await this.db.query(
      `UPDATE routine_runs SET ${sets.join(", ")} WHERE id = $1 AND ${guard} RETURNING id`,
      params
    );
    return rows.length > 0;
  }

  /** Heartbeat for the sweep's stale-run detection. */
  async touch(id: string): Promise<void> {
    await this.db.query("UPDATE routine_runs SET updated_at = now() WHERE id = $1", [id]);
  }

  /** Runs whose wake time passed but no wake job fired (crash window healing). */
  async listOverdueWakes(now: Date): Promise<RoutineRunRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLS} FROM routine_runs
       WHERE wake_at IS NOT NULL AND wake_at <= $1 AND status IN ('sleeping', 'running')`,
      [now]
    );
    return rows.map(rowToRun);
  }

  /** Runs whose per-state deadline passed while still running. */
  async listExpiredDeadlines(now: Date): Promise<RoutineRunRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLS} FROM routine_runs
       WHERE state_deadline IS NOT NULL AND state_deadline <= $1 AND status = 'running'`,
      [now]
    );
    return rows.map(rowToRun);
  }

  /** Next journal seq for a run (1-based). */
  async nextSeq(runId: string): Promise<number> {
    const { rows } = await this.db.query(
      "SELECT COALESCE(MAX(seq), 0) AS max FROM routine_run_events WHERE run_id = $1",
      [runId]
    );
    return Number(rows[0]?.max ?? 0) + 1;
  }

  async appendEvent(event: RunJournalEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO routine_run_events (run_id, seq, type, payload, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (run_id, seq) DO NOTHING`,
      [event.runId, event.seq, event.type, JSON.stringify(event.payload), event.createdAt]
    );
  }

  async listEvents(runId: string, afterSeq = 0): Promise<RunJournalEvent[]> {
    const { rows } = await this.db.query(
      `SELECT run_id, seq, type, payload, created_at FROM routine_run_events
       WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
      [runId, afterSeq]
    );
    return rows.map((r) => ({
      runId: r.run_id as string,
      seq: Number(r.seq),
      type: r.type as string,
      payload: r.payload,
      createdAt: r.created_at as Date,
    }));
  }
}
