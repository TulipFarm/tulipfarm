import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachToStream, mapStreamPart, runChatStream } from "./producer";
import { makeStreamEmitter } from "./stream-emitter";
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
    expect(mapStreamPart({ type: "text-delta", text: "Hi" })).toEqual({
      eventType: "text",
      data: { delta: "Hi" },
    });
    expect(
      mapStreamPart({ type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } })
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
          { type: "tool-result", toolCallId: "c1", toolName: "list_things", output: truncated },
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
          { type: "tool-result", toolCallId: "c2", toolName: "list_things", output: truncated },
          cache
        )
      ).toEqual({
        eventType: "tool-result",
        data: { toolCallId: "c2", toolName: "list_things", result: truncated },
      });
    });

    it("without cache: uses SDK result directly", () => {
      expect(
        mapStreamPart({ type: "tool-result", toolCallId: "c3", toolName: "t", output: truncated })
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
        { type: "text-delta", text: "He" },
        { type: "text-delta", text: "llo" },
        { type: "finish", finishReason: "stop" },
      ]),
      { emitter: makeStreamEmitter(streamId, { repo, hub, log }), hub, log }
    );

    const rows = await repo.listAfter(streamId, 0);
    expect(rows.map((r) => r.eventType)).toEqual(["text", "text", "finish"]);
    expect(seen).toEqual([1, 2, 3]);
    expect(hub.isLive(streamId)).toBe(false);
  });

  it("synthesises a finish when the stream ends without a terminal", async () => {
    await runChatStream(streamId, fromArray([{ type: "text-delta", text: "x" }]), {
      emitter: makeStreamEmitter(streamId, { repo, hub, log }),
      hub,
      log,
    });
    const rows = await repo.listAfter(streamId, 0);
    expect(rows.at(-1)?.eventType).toBe("finish");
  });

  it("emits a terminal error and finishes the hub when iteration throws", async () => {
    async function* boom(): AsyncIterable<unknown> {
      yield { type: "text-delta", text: "partial" };
      throw new Error("provider exploded");
    }
    await runChatStream(streamId, boom(), {
      emitter: makeStreamEmitter(streamId, { repo, hub, log }),
      hub,
      log,
    });
    const rows = await repo.listAfter(streamId, 0);
    expect(rows.map((r) => r.eventType)).toEqual(["text", "error"]);
    expect(rows.at(-1)?.data).toEqual({ message: "provider exploded" });
    expect(hub.isLive(streamId)).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  // ── Output guard: buffer-then-scan (AC-V1-003 stream side) ──────────────────
  describe("scanOutput buffer-then-scan", () => {
    type Emitted = { eventType: string; data: unknown };
    const captureEmitter = (sink: Emitted[]): import("./stream-emitter").StreamEmitter => ({
      emit: (eventType, data) => {
        sink.push({ eventType, data });
        return Promise.resolve();
      },
    });

    it("flushes buffered text as one scanned `text` event before finish (pass)", async () => {
      const emitted: Emitted[] = [];
      const scanOutput = vi.fn(async (text: string) => ({ blocked: false as const, text }));
      await runChatStream(
        streamId,
        fromArray([
          { type: "text-delta", text: "He" },
          { type: "text-delta", text: "llo" },
          { type: "finish", finishReason: "stop" },
        ]),
        { emitter: captureEmitter(emitted), hub, log, scanOutput }
      );

      // Single scan of the concatenated buffer; one merged text event, then finish.
      expect(scanOutput).toHaveBeenCalledTimes(1);
      expect(scanOutput).toHaveBeenCalledWith("Hello");
      expect(emitted).toEqual([
        { eventType: "text", data: { delta: "Hello" } },
        { eventType: "finish", data: { reason: "stop" } },
      ]);
      expect(hub.isLive(streamId)).toBe(false);
    });

    it("emits the scanned (transformed) text when scanOutput rewrites it", async () => {
      const emitted: Emitted[] = [];
      const scanOutput = vi.fn(async () => ({ blocked: false as const, text: "[redacted]" }));
      await runChatStream(
        streamId,
        fromArray([
          { type: "text-delta", text: "secret" },
          { type: "finish", finishReason: "stop" },
        ]),
        { emitter: captureEmitter(emitted), hub, log, scanOutput }
      );
      expect(emitted).toEqual([
        { eventType: "text", data: { delta: "[redacted]" } },
        { eventType: "finish", data: { reason: "stop" } },
      ]);
    });

    it("blocks on the buffered text: guardrail_block + finish, no text, suppresses rest", async () => {
      const emitted: Emitted[] = [];
      const scanOutput = vi.fn(async () => ({
        blocked: true as const,
        guard: "content_filter",
        reason: "credit_card",
        message: "blocked",
      }));
      await runChatStream(
        streamId,
        fromArray([
          { type: "text-delta", text: "card 4111111111111111" },
          // A tool-call after the blocked flush must be suppressed.
          { type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } },
          { type: "finish", finishReason: "stop" },
        ]),
        { emitter: captureEmitter(emitted), hub, log, scanOutput }
      );

      expect(scanOutput).toHaveBeenCalledTimes(1);
      expect(emitted).toEqual([
        {
          eventType: "guardrail_block",
          data: {
            stage: "output",
            guard: "content_filter",
            reason: "credit_card",
            message: "blocked",
          },
        },
        { eventType: "finish", data: { reason: "guardrail_block" } },
      ]);
      // No `text`, no suppressed tool-call, no synthesised stop finish.
      expect(emitted.some((e) => e.eventType === "text")).toBe(false);
      expect(emitted.some((e) => e.eventType === "tool-call")).toBe(false);
      expect(hub.isLive(streamId)).toBe(false);
    });

    it("flushes buffered text before a non-text event (tool-call), then continues", async () => {
      const emitted: Emitted[] = [];
      const scanOutput = vi.fn(async (text: string) => ({ blocked: false as const, text }));
      await runChatStream(
        streamId,
        fromArray([
          { type: "text-delta", text: "before" },
          { type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } },
          { type: "text-delta", text: "after" },
          { type: "finish", finishReason: "stop" },
        ]),
        { emitter: captureEmitter(emitted), hub, log, scanOutput }
      );

      // Two flushes: one before the tool-call, one before finish.
      expect(scanOutput.mock.calls.map((c) => c[0])).toEqual(["before", "after"]);
      expect(emitted).toEqual([
        { eventType: "text", data: { delta: "before" } },
        { eventType: "tool-call", data: { toolCallId: "c1", toolName: "t", args: { a: 1 } } },
        { eventType: "text", data: { delta: "after" } },
        { eventType: "finish", data: { reason: "stop" } },
      ]);
    });

    it("without scanOutput: text deltas emit live exactly as before", async () => {
      const emitted: Emitted[] = [];
      await runChatStream(
        streamId,
        fromArray([
          { type: "text-delta", text: "He" },
          { type: "text-delta", text: "llo" },
          { type: "finish", finishReason: "stop" },
        ]),
        { emitter: captureEmitter(emitted), hub, log }
      );
      expect(emitted).toEqual([
        { eventType: "text", data: { delta: "He" } },
        { eventType: "text", data: { delta: "llo" } },
        { eventType: "finish", data: { reason: "stop" } },
      ]);
    });
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
      yield { type: "text-delta", text: "one" };
      yield { type: "text-delta", text: "two" };
      await gate.promise;
      yield { type: "text-delta", text: "three" };
      yield { type: "finish", finishReason: "stop" };
    }
    void runChatStream(streamId, gated(), {
      emitter: makeStreamEmitter(streamId, { repo, hub, log }),
      hub,
      log,
    });

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

// ── A2UI follow-on emission for view/terminal tools ───────────────────────────
describe("runChatStream a2ui follow-on", () => {
  type Emitted = { eventType: string; data: unknown };
  const captureEmitter = (sink: Emitted[]): import("./stream-emitter").StreamEmitter => ({
    emit: (eventType, data) => {
      sink.push({ eventType, data });
      return Promise.resolve();
    },
  });

  it("emits both tool-result and a2ui for a present_choices result", async () => {
    const hub = new StreamHub();
    const sid = randomUUID();
    const emitted: Emitted[] = [];
    await runChatStream(
      sid,
      fromArray([
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "present_choices",
          output: {
            success: true,
            data: { question: "Pick", choices: [{ label: "A", value: "a" }] },
          },
        },
        { type: "finish", finishReason: "stop" },
      ]),
      { emitter: captureEmitter(emitted), hub, log }
    );
    expect(emitted.map((e) => e.eventType)).toEqual(["tool-result", "a2ui", "finish"]);
    const a2ui = emitted.find((e) => e.eventType === "a2ui");
    expect((a2ui?.data as { html: string }).html).toContain("data-a2ui-send");
  });

  it("emits only tool-result for a non-view tool", async () => {
    const hub = new StreamHub();
    const sid = randomUUID();
    const emitted: Emitted[] = [];
    await runChatStream(
      sid,
      fromArray([
        {
          type: "tool-result",
          toolCallId: "c2",
          toolName: "list_things",
          output: { success: true, data: { items: [] } },
        },
        { type: "finish", finishReason: "stop" },
      ]),
      { emitter: captureEmitter(emitted), hub, log }
    );
    expect(emitted.map((e) => e.eventType)).toEqual(["tool-result", "finish"]);
  });
});
