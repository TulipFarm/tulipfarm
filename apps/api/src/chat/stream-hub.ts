/** One streamed SSE event: a monotonic `seq` (the SSE `id`), a type, and a JSON payload. */
export interface StreamEvent {
  seq: number;
  eventType: string;
  data: unknown;
}

/** A terminal event ends the turn; subscribers close their connection after writing it. */
export function isTerminalEvent(eventType: string): boolean {
  return eventType === "finish" || eventType === "error";
}

type Subscriber = (event: StreamEvent) => void;

interface LiveStream {
  subscribers: Set<Subscriber>;
  done: boolean;
}

/**
 * In-process fan-out for live chat turns (single-node V1). The detached producer
 * `publish`es each event here while it also persists it to `stream_resume`; live
 * connections `subscribe` to the tail. A finished stream is dropped once no
 * subscriber remains — late reconnects then replay purely from the table.
 */
export class StreamHub {
  private readonly streams = new Map<string, LiveStream>();

  /** Open a stream for fan-out. Called once, before the producer starts publishing. */
  register(streamId: string): void {
    if (!this.streams.has(streamId)) {
      this.streams.set(streamId, { subscribers: new Set(), done: false });
    }
  }

  /** True while a stream is registered and not yet finished (i.e. attachable live). */
  isLive(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    return stream !== undefined && !stream.done;
  }

  /** Fan an event out to every current subscriber. No-op if the stream is gone. */
  publish(streamId: string, event: StreamEvent): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    for (const subscriber of stream.subscribers) {
      subscriber(event);
    }
  }

  /**
   * Attach a live listener. Returns an unsubscribe fn that also reaps a finished,
   * now-empty stream. Subscribing to an unknown/finished stream is a no-op (the
   * caller replays from the table instead) and returns a no-op unsubscribe.
   */
  subscribe(streamId: string, onEvent: Subscriber): () => void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.done) return () => {};
    stream.subscribers.add(onEvent);
    return () => {
      stream.subscribers.delete(onEvent);
      this.reapIfEmpty(streamId);
    };
  }

  /** Mark a stream finished; reap it immediately if nobody is attached. */
  finish(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.done = true;
    this.reapIfEmpty(streamId);
  }

  private reapIfEmpty(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream?.done && stream.subscribers.size === 0) {
      this.streams.delete(streamId);
    }
  }
}
