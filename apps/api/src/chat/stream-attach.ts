import type { ServerResponse } from "node:http";
import { writeSseEvent } from "./sse";
import { isTerminalEvent, type StreamEvent, type StreamHub } from "./stream-hub";
import type { StreamResumeRepo } from "./stream-resume";

/**
 * Reader side of the in-memory stream hub, still serving Routine runs.
 *
 * Chat no longer streams this way — a chat turn is read back from `run_events`, the durable stream
 * every channel shares. Routine runs are migrated in PR 4; until then this is what attaches a
 * client to one, and it stays a reader: a disconnect detaches, it never stops the producer.
 */

export interface AttachDeps {
  repo: StreamResumeRepo;
  hub: StreamHub;
}

/**
 * Stream a hijacked connection from `afterSeq`. Subscribes to the live tail FIRST
 * (buffering), then replays the durable rows after `afterSeq`, then flushes the
 * buffer (de-duped by seq) and goes live — closing the response on the terminal
 * event. A client disconnect detaches the reader but never stops the producer.
 * Resolves when the connection ends.
 */
export function attachToStream(
  raw: ServerResponse,
  streamId: string,
  afterSeq: number,
  deps: AttachDeps
): Promise<void> {
  return new Promise((resolve) => {
    let closed = false;
    let live = false;
    let lastSeq = afterSeq;
    const buffer: StreamEvent[] = [];
    let unsub: () => void = () => {};

    const detach = (): void => {
      if (closed) return;
      closed = true;
      unsub();
    };
    const close = (): void => {
      if (closed) return;
      detach();
      raw.end();
      resolve();
    };
    const send = (event: StreamEvent): void => {
      if (closed || event.seq <= lastSeq) return;
      writeSseEvent(raw, event);
      lastSeq = event.seq;
      if (isTerminalEvent(event.eventType)) close();
    };

    unsub = deps.hub.subscribe(streamId, (event) => {
      if (live) send(event);
      else buffer.push(event);
    });

    raw.on("close", () => {
      if (!closed) {
        detach();
        resolve();
      }
    });

    deps.repo
      .listAfter(streamId, afterSeq)
      .then((replay) => {
        for (const event of replay) send(event);
        if (closed) return;
        for (const event of buffer) send(event);
        if (closed) return;
        // Nothing live left to produce (finished/expired, or resumed past the end):
        // close now rather than hang waiting for events that will never arrive.
        if (!deps.hub.isLive(streamId)) {
          close();
          return;
        }
        live = true;
      })
      .catch(() => close());
  });
}
