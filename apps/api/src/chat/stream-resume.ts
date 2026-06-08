import type { Queryable } from "../db";
import type { StreamEvent } from "./stream-hub";

/** One buffered SSE event, durable for replay on reconnect. */
export interface StreamEventRow {
  streamId: string;
  seq: number;
  eventType: string;
  data: unknown;
  createdAt: Date;
}

export interface StreamResumeRepo {
  /** Persist one streamed event. Idempotent on `(stream_id, seq)`. */
  append(row: StreamEventRow): Promise<void>;
  /** Events for a stream with `seq > afterSeq`, ascending — the replay tail. */
  listAfter(streamId: string, afterSeq: number): Promise<StreamEvent[]>;
  /** GC: delete every event row created before `cutoff`. Returns rows removed. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}

function rowToEvent(row: Record<string, unknown>): StreamEvent {
  return {
    seq: Number(row.seq),
    eventType: row.event_type as string,
    data: row.data,
  };
}

export class PgStreamResumeRepo implements StreamResumeRepo {
  constructor(private readonly q: Queryable) {}

  async append(row: StreamEventRow): Promise<void> {
    await this.q.query(
      `INSERT INTO stream_resume (stream_id, seq, event_type, data, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (stream_id, seq) DO NOTHING`,
      [row.streamId, row.seq, row.eventType, JSON.stringify(row.data), row.createdAt]
    );
  }

  async listAfter(streamId: string, afterSeq: number): Promise<StreamEvent[]> {
    const { rows } = await this.q.query(
      "SELECT seq, event_type, data FROM stream_resume WHERE stream_id = $1 AND seq > $2 ORDER BY seq",
      [streamId, afterSeq]
    );
    return rows.map(rowToEvent);
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const { rows } = await this.q.query(
      "DELETE FROM stream_resume WHERE created_at < $1 RETURNING seq",
      [cutoff]
    );
    return rows.length;
  }
}

/** In-memory implementation for tests and the default `buildApp` wiring. */
export class MemoryStreamResumeRepo implements StreamResumeRepo {
  readonly rows: StreamEventRow[] = [];

  async append(row: StreamEventRow): Promise<void> {
    if (this.rows.some((r) => r.streamId === row.streamId && r.seq === row.seq)) return;
    this.rows.push({ ...row });
  }

  async listAfter(streamId: string, afterSeq: number): Promise<StreamEvent[]> {
    return this.rows
      .filter((r) => r.streamId === streamId && r.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ seq: r.seq, eventType: r.eventType, data: r.data }));
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const before = this.rows.length;
    const kept = this.rows.filter((r) => r.createdAt >= cutoff);
    this.rows.length = 0;
    this.rows.push(...kept);
    return before - this.rows.length;
  }
}
