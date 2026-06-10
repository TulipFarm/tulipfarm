import type { StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";

/** Emits one SSE event into a stream: allocates a seq, persists it, fans it out. */
export interface StreamEmitter {
  emit(eventType: string, data: unknown): Promise<void>;
}

interface StreamEmitterDeps {
  repo: StreamResumeRepo;
  hub: StreamHub;
  log: { error: (obj: unknown, msg?: string) => void };
}

/**
 * Per-turn event emitter owning the stream's monotonic `seq`. Shared by the producer loop AND the
 * approval gate so both stay on ONE seq space. Emits are SERIALIZED through an internal promise queue:
 * seq allocation → `stream_resume` append → `hub.publish` happen atomically per event and strictly in
 * call order. Two concurrent callers must never publish out of order — `attachToStream.send` drops any
 * `seq <= lastSeq`, so a reordered live publish silently loses an event. An append failure is logged
 * and does not break the chain (the event is still fanned out; reconnect just won't replay it).
 */
export function makeStreamEmitter(streamId: string, deps: StreamEmitterDeps): StreamEmitter {
  let seq = 0;
  let tail: Promise<void> = Promise.resolve();

  const emit = (eventType: string, data: unknown): Promise<void> => {
    const run = tail.then(async () => {
      seq += 1;
      try {
        await deps.repo.append({ streamId, seq, eventType, data, createdAt: new Date() });
      } catch (err) {
        deps.log.error({ err, streamId }, "stream_resume append failed");
      }
      deps.hub.publish(streamId, { seq, eventType, data });
    });
    tail = run.catch(() => {});
    return run;
  };

  return { emit };
}
