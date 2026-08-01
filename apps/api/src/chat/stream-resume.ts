import type { StreamEvent } from "./stream-hub";

/** One buffered SSE event, durable for replay on reconnect. */
export interface StreamEventRow {
  streamId: string;
  seq: number;
  eventType: string;
  data: unknown;
  createdAt: Date;
}

/**
 * Replay tail behind a resumable hub stream.
 *
 * The chat implementation and its `stream_resume` table are gone: a chat turn is read back from
 * `run_events`, which the Worker writes and every channel reads. What remains is the contract, and
 * `routines/stream-adapter.ts` is its one implementation — over `routine_run_events`, the Routine's
 * own journal. PR 4 moves Routines onto `run_events` too and this goes with them.
 */
export interface StreamResumeRepo {
  /** Persist one streamed event. Idempotent on `(stream_id, seq)`. */
  append(row: StreamEventRow): Promise<void>;
  /** Events for a stream with `seq > afterSeq`, ascending — the replay tail. */
  listAfter(streamId: string, afterSeq: number): Promise<StreamEvent[]>;
  /** GC: delete every event row created before `cutoff`. Returns rows removed. */
  deleteOlderThan(cutoff: Date): Promise<number>;
}
