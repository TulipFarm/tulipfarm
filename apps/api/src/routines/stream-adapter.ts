import type { StreamEvent } from "../chat/stream-hub";
import type { StreamResumeRepo } from "../chat/stream-resume";
import type { RoutineRunsRepo } from "./repo";

/** streamId for a run's SSE stream. Namespaced so it can never collide with chat ids. */
export function runStreamId(runId: string): string {
  return `routine-run:${runId}`;
}

function runIdOf(streamId: string): string {
  return streamId.replace(/^routine-run:/, "");
}

/**
 * StreamResumeRepo over `routine_run_events`: the journal IS the SSE replay buffer
 * (review fix B1/B2). One write path — no stream_resume rows, no 1h GC, Last-Event-ID
 * replay works for runs of any age, and emitter seq seeding falls out of `nextSeq`.
 * `deleteOlderThan` is a no-op: run history is a product feature, never GC'd here.
 */
export class RunJournalStreamRepo implements StreamResumeRepo {
  constructor(private readonly runs: RoutineRunsRepo) {}

  async append(row: {
    streamId: string;
    seq: number;
    eventType: string;
    data: unknown;
    createdAt: Date;
  }): Promise<void> {
    await this.runs.appendEvent({
      runId: runIdOf(row.streamId),
      seq: row.seq,
      type: row.eventType,
      payload: row.data,
      createdAt: row.createdAt,
    });
  }

  async listAfter(streamId: string, afterSeq: number): Promise<StreamEvent[]> {
    const events = await this.runs.listEvents(runIdOf(streamId), afterSeq);
    return events.map((e) => ({ seq: e.seq, eventType: e.type, data: e.payload }));
  }

  async deleteOlderThan(_cutoff: Date): Promise<number> {
    return 0;
  }
}
