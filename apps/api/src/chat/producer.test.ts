import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachToStream, mapStreamPart, runChatStream } from "./producer";
import { StreamHub } from "./stream-hub";
import { MemoryStreamResumeRepo } from "./stream-resume";

// ── Fake hijacked response ────────────────────────────────────────────────────
class FakeRes {
  chunks: string[] = [];
  ended = false;
  private closeCbs: Array<() => void> = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  on(event: string, cb: () => void): this {
    if (event === "close") this.closeCbs.push(cb);
    return this;
  }
  triggerClose(): void {
    for (const cb of this.closeCbs) cb();
  }
  get body(): string {
    return this.chunks.join("");
  }
  ids(): number[] {
    return [...this.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  }
}
const asRes = (r: FakeRes) => r as unknown as ServerResponse;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function* fromArray(parts: unknown[]): AsyncIterable<unknown> {
  for (const p of parts) yield p;
}

const log = { error: vi.fn() };

describe("mapStreamPart", () => {
  it("maps the client-relevant parts", () => {
    expect(mapStreamPart({ type: "text-delta", textDelta: "Hi" })).toEqual({
      eventType: "text",
      data: { delta: "Hi" },
    });
    expect(
      mapStreamPart({ type: "tool-call", toolCallId: "c1", toolName: "t", args: { a: 1 } })
    ).toEqual({
      eventType: "tool-call",
      data: { toolCallId: "c1", toolName: "t", args: { a: 1 } },
    });
    expect(mapStreamPart({ type: "finish", finishReason: "stop" })).toEqual({
      eventType: "finish",
      data: { reason: "stop" },
    });
    expect(mapStreamPart({ type: "error", error: new Error("boom") })).toEqual({
      eventType: "error",
      data: { message: "boom" },
    });
  });

  it("ignores internal parts and junk", () => {
    expect(mapStreamPart({ type: "step-finish" })).toBeNull();
    expect(mapStreamPart({ type: "reasoning", textDelta: "x" })).toBeNull();
    expect(mapStreamPart(null)).toBeNull();
    expect(mapStreamPart("nope")).toBeNull();
  });

  describe("tool-result full-result cache (TOOL-V1-010)", () => {
    const truncated = {
      success: true as const,
      data: { items: [1], total_count: 25, truncated: true },
    };
    const full = { success: true as const, data: Array.from({ length: 25 }, (_, i) => i) };

    it("uses cached full result when cache has the toolCallId", () => {
      const cache = new Map([["c1", full]]);
      expect(
        mapStreamPart(
          { type: "tool-result", toolCallId: "c1", toolName: "list_things", result: truncated },
          cache
        )
      ).toEqual({
        eventType: "tool-result",
        data: { toolCallId: "c1", toolName: "list_things", result: full },
      });
    });

    it("falls back to SDK result when cache has no entry for toolCallId", () => {
      const cache = new Map<string, import("../tools/types").ToolCallResult>();
      expect(
        mapStreamPart(
          { type: "tool-result", toolCallId: "c2", toolName: "list_things", result: truncated },
          cache
        )
      ).toEqual({
        eventType: "tool-result",
        data: { toolCallId: "c2", toolName: "list_things", result: truncated },
      });
    });

    it("without cache: uses SDK result directly", () => {
      expect(
        mapStreamPart({ type: "tool-result", toolCallId: "c3", toolName: "t", result: truncated })
      ).toEqual({
        eventType: "tool-result",
        data: { toolCallId: "c3", toolName: "t", result: truncated },
      });
    });
  });
});

describe("runChatStream", () => {
  let repo: MemoryStreamResumeRepo;
  let hub: StreamHub;
  let streamId: string;

  beforeEach(() => {
    repo = new MemoryStreamResumeRepo();
    hub = new StreamHub();
    streamId = randomUUID();
    hub.register(streamId);
    log.error.mockReset();
  });

  it("persists + publishes each event and finishes the hub", async () => {
    const seen: number[] = [];
    hub.subscribe(streamId, (e) => seen.push(e.seq));
    await runChatStream(
      streamId,
      fromArray([
        { type: "text-delta", textDelta: "He" },
        { type: "text-delta", textDelta: "llo" },
        { type: "finish", finishReason: "stop" },
      ]),
      { repo, hub, log }
    );

    const rows = await repo.listAfter(streamId, 0);
    expect(rows.map((r) => r.eventType)).toEqual(["text", "text", "finish"]);
    expect(seen).toEqual([1, 2, 3]);
    expect(hub.isLive(streamId)).toBe(false);
  });

  it("synthesises a finish when the stream ends without a terminal", async () => {
    await runChatStream(streamId, fromArray([{ type: "text-delta", textDelta: "x" }]), {
      repo,
      hub,
      log,
    });
    const rows = await repo.listAfter(streamId, 0);
    expect(rows.at(-1)?.eventType).toBe("finish");
  });

  it("emits a terminal error and finishes the hub when iteration throws", async () => {
    async function* boom(): AsyncIterable<unknown> {
      yield { type: "text-delta", textDelta: "partial" };
      throw new Error("provider exploded");
    }
    await runChatStream(streamId, boom(), { repo, hub, log });
    const rows = await repo.listAfter(streamId, 0);
    expect(rows.map((r) => r.eventType)).toEqual(["text", "error"]);
    expect(rows.at(-1)?.data).toEqual({ message: "provider exploded" });
    expect(hub.isLive(streamId)).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});

describe("attachToStream", () => {
  let repo: MemoryStreamResumeRepo;
  let hub: StreamHub;
  let streamId: string;

  beforeEach(() => {
    repo = new MemoryStreamResumeRepo();
    hub = new StreamHub();
    streamId = randomUUID();
    log.error.mockReset();
  });

  it("replays a finished stream from the table then ends (no hub)", async () => {
    for (const [seq, type, data] of [
      [1, "text", { delta: "a" }],
      [2, "finish", { reason: "stop" }],
    ] as const) {
      await repo.append({ streamId, seq, eventType: type, data, createdAt: new Date() });
    }
    const res = new FakeRes();
    await attachToStream(asRes(res), streamId, 0, { repo, hub });
    expect(res.ids()).toEqual([1, 2]);
    expect(res.body).toContain("event: finish");
    expect(res.ended).toBe(true);
  });

  it("replays only the tail after Last-Event-ID", async () => {
    for (let seq = 1; seq <= 3; seq++) {
      await repo.append({ streamId, seq, eventType: "text", data: { seq }, createdAt: new Date() });
    }
    await repo.append({ streamId, seq: 4, eventType: "finish", data: {}, createdAt: new Date() });
    const res = new FakeRes();
    await attachToStream(asRes(res), streamId, 2, { repo, hub });
    expect(res.ids()).toEqual([3, 4]);
  });

  it("404-equivalent: closes immediately for an unknown finished stream", async () => {
    const res = new FakeRes();
    await attachToStream(asRes(res), streamId, 0, { repo, hub });
    expect(res.body).toBe("");
    expect(res.ended).toBe(true);
  });

  // ── Kill mid-turn, reconnect with Last-Event-ID, finish the turn (ticket AC1) ──
  it("replays missed events on reconnect and finishes the live turn", async () => {
    hub.register(streamId);
    const gate = deferred();
    async function* gated(): AsyncIterable<unknown> {
      yield { type: "text-delta", textDelta: "one" };
      yield { type: "text-delta", textDelta: "two" };
      await gate.promise;
      yield { type: "text-delta", textDelta: "three" };
      yield { type: "finish", finishReason: "stop" };
    }
    void runChatStream(streamId, gated(), { repo, hub, log });

    // First connection: receive events 1 & 2, then the client drops.
    const res1 = new FakeRes();
    void attachToStream(asRes(res1), streamId, 0, { repo, hub });
    await waitFor(() => res1.ids().length >= 2);
    expect(res1.ids()).toEqual([1, 2]);
    res1.triggerClose();

    // Producer keeps running server-side; release the rest of the turn.
    gate.resolve();
    await waitFor(() => !hub.isLive(streamId));

    // Reconnect with Last-Event-ID = 2: replay only the missed events + terminal.
    const res2 = new FakeRes();
    await attachToStream(asRes(res2), streamId, 2, { repo, hub });
    expect(res2.ids()).toEqual([3, 4]);
    expect(res2.body).toContain("three");
    expect(res2.body).not.toContain("one");
    expect(res2.body).toContain("event: finish");
    expect(res2.ended).toBe(true);
  });
});
