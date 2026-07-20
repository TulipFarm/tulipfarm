import type { StreamEvent, StreamHub } from "../chat/stream-hub";
import type { StreamResumeRepo } from "../chat/stream-resume";
import type { RoutineRunsRepo, RunJournalEvent } from "./repo";

/** streamId for a run's SSE stream. Namespaced so it can never collide with chat ids. */
export function runStreamId(runId: string): string {
  return `routine-run:${runId}`;
}

type RunStreamLogger = { error: (obj: unknown, msg?: string) => void };

/** Fan out rows only after their journal transaction commits. Replay heals any live failure. */
export function publishRunEvents(
  runId: string,
  events: RunJournalEvent[],
  hub: StreamHub,
  log: RunStreamLogger
): void {
  const streamId = runStreamId(runId);
  for (const event of events) {
    try {
      hub.publish(streamId, { seq: event.seq, eventType: event.type, data: event.payload });
    } catch (err) {
      log.error({ err, streamId, seq: event.seq }, "routine journal live publish failed");
    }
  }
}

/** Serialized append-and-publish path for engine events outside a Run-row transition. */
export function makeRunJournalEmitter(
  runId: string,
  deps: { runs: RoutineRunsRepo; hub: StreamHub; log: RunStreamLogger }
): { emit(type: string, data: Record<string, unknown>): Promise<void> } {
  let tail = Promise.resolve();
  const emit = (type: string, data: Record<string, unknown>): Promise<void> => {
    const write = tail.then(async () => {
      const events = await deps.runs.appendEvents(runId, [{ type, payload: data }]);
      publishRunEvents(runId, events, deps.hub, deps.log);
    });
    tail = write.catch(() => {});
    return write;
  };
  return { emit };
}

function runIdOf(streamId: string): string {
  return streamId.replace(/^routine-run:/, "");
}

/**
 * StreamResumeRepo over `routine_run_events`: the journal IS the SSE replay buffer
 * (review fix B1/B2). One write path — no stream_resume rows, no 1h GC, Last-Event-ID
 * replay works for runs of any age. `deleteOlderThan` is a no-op because Run history
 * is a product feature, never GC'd here.
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
    await this.runs.appendEvents(runIdOf(row.streamId), [
      { type: row.eventType, payload: row.data as Record<string, unknown> },
    ]);
  }

  async listAfter(streamId: string, afterSeq: number): Promise<StreamEvent[]> {
    const events = await this.runs.listEvents(runIdOf(streamId), afterSeq);
    return events.map((e) => ({ seq: e.seq, eventType: e.type, data: e.payload }));
  }

  async deleteOlderThan(_cutoff: Date): Promise<number> {
    return 0;
  }
}
