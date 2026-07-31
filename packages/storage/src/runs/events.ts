import type { TransactionPort } from "../ports";

/**
 * Who an event may be shown to. Listing requires the reader's audiences explicitly, so an event is
 * withheld unless the reader was granted its audience (default-deny).
 */
export type RunEventAudience = "participant" | "operator";

export interface PersistedRunEvent {
  readonly businessId: string;
  readonly runId: string;
  /** Gapless per-Run cursor; the SSE `id:` field and the `?after=` cursor. */
  readonly sequence: number;
  readonly eventType: string;
  readonly audience: RunEventAudience;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
}

export interface AppendRunEventInput {
  readonly businessId: string;
  readonly runId: string;
  readonly eventType: string;
  readonly audience: RunEventAudience;
  readonly payload: Record<string, unknown>;
  /** Producer-side de-duplication key; a duplicate delivery reuses the recorded event. */
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

export interface ListRunEventsOptions {
  readonly after: number;
  readonly audiences: readonly RunEventAudience[];
  readonly limit?: number;
}

export const DEFAULT_RUN_EVENT_PAGE_SIZE = 500;

/**
 * Persisted Run event stream (SPEC §§18, 19). Every event a client can observe is durable and
 * numbered, so a dropped connection is recovered by replaying `?after=<sequence>` rather than by
 * re-deriving Run state — losing the stream never changes the Run.
 */
export const RUN_EVENT_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_events (
    business_id      text NOT NULL,
    run_id           uuid NOT NULL,
    sequence         bigint NOT NULL CHECK (sequence > 0),
    event_type       text NOT NULL CHECK (length(event_type) > 0),
    audience         text NOT NULL CHECK (audience IN ('participant', 'operator')),
    payload          jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    idempotency_key  text NOT NULL CHECK (length(idempotency_key) > 0),
    occurred_at      timestamptz NOT NULL,
    PRIMARY KEY (business_id, run_id, sequence),
    UNIQUE (business_id, run_id, idempotency_key),
    FOREIGN KEY (business_id, run_id) REFERENCES runs(business_id, id)
  )`,
  `CREATE OR REPLACE FUNCTION reject_run_event_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'run_event_append_only';
    END;
    $$`,
  "DROP TRIGGER IF EXISTS run_events_append_only ON run_events",
  `CREATE TRIGGER run_events_append_only
    BEFORE UPDATE OR DELETE ON run_events
    FOR EACH ROW EXECUTE FUNCTION reject_run_event_change()`,
];

/** The channel a reader listens on to be told an event landed. */
export const RUN_EVENT_NOTIFY_CHANNEL = "run_events";

/**
 * A wake-up hint for readers, and nothing more.
 *
 * The notification carries `<run_id>:<sequence>` so a listener knows which stream advanced, but a
 * reader must still fetch by cursor: notifications are not delivered to a disconnected listener and
 * are dropped outright if the queue overflows. Losing every notification therefore costs latency
 * (the reader falls back to its poll interval) and never correctness — which is why this is a
 * separate statement set rather than something the append path depends on.
 */
export const RUN_EVENT_NOTIFY_STATEMENTS: readonly string[] = [
  `CREATE OR REPLACE FUNCTION notify_run_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('${RUN_EVENT_NOTIFY_CHANNEL}', NEW.run_id || ':' || NEW.sequence);
      RETURN NULL;
    END;
    $$`,
  "DROP TRIGGER IF EXISTS run_events_notify ON run_events",
  `CREATE TRIGGER run_events_notify
    AFTER INSERT ON run_events
    FOR EACH ROW EXECUTE FUNCTION notify_run_event()`,
];

interface RunEventRow {
  business_id: string;
  run_id: string;
  sequence: string | number;
  event_type: string;
  audience: RunEventAudience;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
}

const RUN_EVENT_COLUMNS =
  "business_id, run_id, sequence, event_type, audience, payload, occurred_at";

function persistedRunEvent(row: RunEventRow): PersistedRunEvent {
  return {
    businessId: row.business_id,
    runId: row.run_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    audience: row.audience,
    payload: row.payload,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

/** Append-only Run event log with a gapless per-Run sequence. */
export class RunEventStore {
  constructor(private readonly transactions: TransactionPort) {}

  /**
   * Appends one event. The Run row is locked while the next sequence is derived, so concurrent
   * producers cannot mint the same cursor; a repeated `idempotencyKey` returns the recorded event
   * unchanged instead of emitting a second copy.
   */
  async append(input: AppendRunEventInput): Promise<PersistedRunEvent> {
    return this.transactions.withTransaction(async (transaction) => {
      await transaction.query("SELECT id FROM runs WHERE business_id = $1 AND id = $2 FOR UPDATE", [
        input.businessId,
        input.runId,
      ]);
      const inserted = await transaction.query<RunEventRow>(
        `INSERT INTO run_events (
           business_id, run_id, sequence, event_type, audience, payload, idempotency_key, occurred_at
         )
         SELECT $1, $2,
                COALESCE(
                  (SELECT MAX(sequence) FROM run_events WHERE business_id = $1 AND run_id = $2),
                  0
                ) + 1,
                $3, $4, $5::jsonb, $6, $7::timestamptz
         ON CONFLICT (business_id, run_id, idempotency_key) DO NOTHING
         RETURNING ${RUN_EVENT_COLUMNS}`,
        [
          input.businessId,
          input.runId,
          input.eventType,
          input.audience,
          JSON.stringify(input.payload),
          input.idempotencyKey,
          input.occurredAt,
        ]
      );
      const row = inserted.rows[0];
      if (row) return persistedRunEvent(row);

      const existing = await transaction.query<RunEventRow>(
        `SELECT ${RUN_EVENT_COLUMNS}
           FROM run_events
          WHERE business_id = $1 AND run_id = $2 AND idempotency_key = $3`,
        [input.businessId, input.runId, input.idempotencyKey]
      );
      return persistedRunEvent(existing.rows[0]);
    });
  }

  /** Events after `after` the reader is allowed to see, oldest first and bounded. */
  async list(
    businessId: string,
    runId: string,
    options: ListRunEventsOptions
  ): Promise<readonly PersistedRunEvent[]> {
    if (options.audiences.length === 0) return [];
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<RunEventRow>(
        `SELECT ${RUN_EVENT_COLUMNS}
           FROM run_events
          WHERE business_id = $1
            AND run_id = $2
            AND sequence > $3
            AND audience = ANY($4::text[])
          ORDER BY sequence
          LIMIT $5`,
        [
          businessId,
          runId,
          options.after,
          options.audiences,
          options.limit ?? DEFAULT_RUN_EVENT_PAGE_SIZE,
        ]
      );
      return result.rows.map(persistedRunEvent);
    });
  }

  /** Highest sequence recorded for a Run, or 0 when the stream is empty. */
  async latestSequence(businessId: string, runId: string): Promise<number> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{ sequence: string | number | null }>(
        `SELECT MAX(sequence) AS sequence
           FROM run_events
          WHERE business_id = $1 AND run_id = $2`,
        [businessId, runId]
      );
      return Number(result.rows[0]?.sequence ?? 0);
    });
  }
}
