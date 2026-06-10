import { describe, expect, it, vi } from "vitest";
import { makeStreamEmitter } from "./stream-emitter";
import { StreamHub } from "./stream-hub";
import { MemoryStreamResumeRepo } from "./stream-resume";
import type { StreamEventRow, StreamResumeRepo } from "./stream-resume";

const log = { error: vi.fn() };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("makeStreamEmitter", () => {
  it("assigns a monotonic seq, appends, then publishes — in order", async () => {
    const repo = new MemoryStreamResumeRepo();
    const hub = new StreamHub();
    const streamId = "s1";
    hub.register(streamId);
    const published: number[] = [];
    hub.subscribe(streamId, (e) => published.push(e.seq));

    const emitter = makeStreamEmitter(streamId, { repo, hub, log });
    await emitter.emit("text", { delta: "a" });
    await emitter.emit("text", { delta: "b" });
    await emitter.emit("finish", { reason: "stop" });

    expect((await repo.listAfter(streamId, 0)).map((r) => r.eventType)).toEqual([
      "text",
      "text",
      "finish",
    ]);
    expect(published).toEqual([1, 2, 3]);
  });

  // The whole reason this type exists: a second concurrent emitter (the approval gate) must not
  // race the producer loop. attachToStream.send drops any seq <= lastSeq, so an out-of-order publish
  // silently loses a live event. The internal tail-chain serializes seq+append+publish atomically.
  it("serializes concurrent emits in call order despite variable append latency", async () => {
    const order: string[] = [];
    // append for seq 1 is the SLOWEST — without serialization, publish order would be 3,2,1.
    const delays = [20, 10, 0];
    class DelayedRepo implements StreamResumeRepo {
      async append(row: StreamEventRow): Promise<void> {
        await sleep(delays[row.seq - 1] ?? 0);
        order.push(`append:${row.seq}`);
      }
      async listAfter(): Promise<never[]> {
        return [];
      }
      async deleteOlderThan(): Promise<number> {
        return 0;
      }
    }
    const hub = new StreamHub();
    const streamId = "s1";
    hub.register(streamId);
    const published: number[] = [];
    hub.subscribe(streamId, (e) => {
      order.push(`publish:${e.seq}`);
      published.push(e.seq);
    });

    const emitter = makeStreamEmitter(streamId, { repo: new DelayedRepo(), hub, log });
    await Promise.all([
      emitter.emit("text", { delta: "1" }),
      emitter.emit("text", { delta: "2" }),
      emitter.emit("text", { delta: "3" }),
    ]);

    expect(published).toEqual([1, 2, 3]);
    expect(order).toEqual([
      "append:1",
      "publish:1",
      "append:2",
      "publish:2",
      "append:3",
      "publish:3",
    ]);
  });

  it("logs and keeps going (still publishes, keeps seq order) when append fails", async () => {
    log.error.mockReset();
    const published: number[] = [];
    class FlakyRepo implements StreamResumeRepo {
      async append(row: StreamEventRow): Promise<void> {
        if (row.seq === 1) throw new Error("db down");
      }
      async listAfter(): Promise<never[]> {
        return [];
      }
      async deleteOlderThan(): Promise<number> {
        return 0;
      }
    }
    const hub = new StreamHub();
    const streamId = "s1";
    hub.register(streamId);
    hub.subscribe(streamId, (e) => published.push(e.seq));

    const emitter = makeStreamEmitter(streamId, { repo: new FlakyRepo(), hub, log });
    await emitter.emit("text", { delta: "1" });
    await emitter.emit("text", { delta: "2" });

    expect(published).toEqual([1, 2]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
