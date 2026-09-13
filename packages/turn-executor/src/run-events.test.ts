import type { AgentLoopEvent } from "@tulipfarm/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  type AppendedRunEvent,
  DuplicateLoopEventError,
  InvalidRunEventPayloadError,
  type RunEventAppendPort,
  type TurnAttemptHistory,
  TurnEventWriter,
} from "./run-events";

interface Appended {
  eventType: string;
  audience: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

class FakeAppendPort implements RunEventAppendPort {
  readonly appended: Appended[] = [];
  private sequence = 0;
  private readonly byKey = new Map<string, number>();

  async append(input: {
    businessId: string;
    runId: string;
    eventType: string;
    audience: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    occurredAt: string;
  }): Promise<AppendedRunEvent> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing !== undefined) {
      const event = this.appended[existing - 1];
      return { sequence: existing, eventType: event?.eventType, payload: event?.payload };
    }
    this.sequence += 1;
    this.byKey.set(input.idempotencyKey, this.sequence);
    this.appended.push({
      eventType: input.eventType,
      audience: input.audience,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
    });
    return { sequence: this.sequence, eventType: input.eventType, payload: input.payload };
  }
}

function makeWriter(
  events: RunEventAppendPort,
  attempt = 1,
  initial?: TurnAttemptHistory
): TurnEventWriter {
  return new TurnEventWriter({
    events,
    businessId: "biz",
    runId: "run-1",
    turnId: "turn-1",
    attempt,
    ...(initial === undefined ? {} : { initial }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

function loopEvent(over: Partial<AgentLoopEvent> & Pick<AgentLoopEvent, "type">): AgentLoopEvent {
  return {
    sequence: 1,
    businessId: "biz",
    runId: "run-1",
    stateId: "state-1",
    iteration: 1,
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("TurnEventWriter", () => {
  it("stamps the audience the vocabulary assigns, not one the caller chooses", async () => {
    const events = new FakeAppendPort();
    const writer = makeWriter(events);

    await writer.emit(
      "turn.started",
      { turnId: "turn-1", attempt: 1, agentId: "agent" },
      "started"
    );
    await writer.emit(
      "context.assembled",
      { contextDigest: "ctx", guardrailDigest: "gr" },
      "context"
    );

    expect(events.appended.map((event) => [event.eventType, event.audience])).toEqual([
      ["turn.started", "participant"],
      ["context.assembled", "operator"],
    ]);
  });

  it("refuses a payload the published schema rejects instead of appending it", async () => {
    const events = new FakeAppendPort();
    const writer = makeWriter(events);

    await expect(
      writer.emit(
        "turn.started",
        // A caller assembling this from runtime data can still get it wrong; AJV is the backstop.
        { turnId: "turn-1", attempt: 1 } as never,
        "started"
      )
    ).rejects.toBeInstanceOf(InvalidRunEventPayloadError);
    expect(events.appended).toHaveLength(0);
  });

  it("derives the same idempotency key on redelivery, so nothing is written twice", async () => {
    const events = new FakeAppendPort();
    const payload = { turnId: "turn-1", attempt: 1, agentId: "agent" } as const;

    await makeWriter(events).emit("turn.started", payload, "started");
    await makeWriter(events).emit("turn.started", payload, "started");

    expect(events.appended).toHaveLength(1);
    expect(events.appended[0].idempotencyKey).toBe("turn-1:1:started");
  });

  it("keys a retry's events by its own attempt, so the reader sees a fresh stream", async () => {
    const events = new FakeAppendPort();
    const payload = { turnId: "turn-1", attempt: 2, agentId: "agent" } as const;

    await makeWriter(events, 1).emit("turn.started", { ...payload, attempt: 1 }, "started");
    await makeWriter(events, 2).emit("turn.started", payload, "started");

    expect(events.appended.map((event) => event.idempotencyKey)).toEqual([
      "turn-1:1:started",
      "turn-1:2:started",
    ]);
  });

  it("tracks the highest appended sequence as the completion cursor", async () => {
    const events = new FakeAppendPort();
    const writer = makeWriter(events);
    expect(writer.cursor).toBe(0);

    await writer.emit("turn.started", { turnId: "turn-1", attempt: 1, agentId: "a" }, "started");
    await writer.emit("turn.finished", { status: "succeeded", messageId: "m1" }, "finished");

    expect(writer.cursor).toBe(2);
  });

  it("folds later passes into the same ordered Tool and exact Surface history", async () => {
    const events = new FakeAppendPort();
    const first = makeWriter(events);
    await first.append(
      loopEvent({ sequence: 1, type: "text_delta", text: "First. ", textIndex: 0 })
    );
    await first.emit(
      "tool.call",
      { callId: "call-1", name: "record_list", argsDigest: "sha256:first" },
      "tool:call:call-1"
    );
    first.recordSurface({ artifactId: "surface-1", revision: 3 });

    const resumed = makeWriter(events, 1, first.history("waiting"));
    await resumed.emit("tool.result", { callId: "call-1", status: "ok" }, "tool:result:call-1");
    await resumed.emit(
      "tool.call",
      { callId: "call-2", name: "record_get", argsDigest: "sha256:second" },
      "tool:call:call-2"
    );
    resumed.recordSurface({ artifactId: "surface-1", revision: 5 });
    resumed.recordSurface({ artifactId: "surface-1", revision: 4 });
    resumed.recordSurface({ artifactId: "surface-2", revision: 7 });

    expect(resumed.history("succeeded", true)).toMatchObject({
      text: "First. ",
      events: [
        {
          sequence: 1,
          eventType: "text.delta",
          payload: { text: "First. ", index: 0 },
        },
        {
          sequence: 2,
          eventType: "tool.call",
          payload: { callId: "call-1", name: "record_list", argsDigest: "sha256:first" },
        },
        {
          sequence: 3,
          eventType: "tool.result",
          payload: { callId: "call-1", status: "ok" },
        },
        {
          sequence: 4,
          eventType: "tool.call",
          payload: { callId: "call-2", name: "record_get", argsDigest: "sha256:second" },
        },
      ],
      toolCalls: [
        { callId: "call-1", name: "record_list", outcome: "ok" },
        { callId: "call-2", name: "record_get" },
      ],
      surfaces: [
        { artifactId: "surface-1", revision: 5 },
        { artifactId: "surface-2", revision: 7 },
      ],
      outcome: "succeeded",
      complete: true,
    });
  });

  it("keeps operator events out of participant attempt history", async () => {
    const events = new FakeAppendPort();
    const writer = makeWriter(events);

    await writer.emit(
      "context.assembled",
      { contextDigest: "ctx", guardrailDigest: "guard" },
      "context"
    );
    await writer.emit("text.delta", { text: "Safe", index: 0 }, "text");

    expect(writer.history().events).toEqual([
      {
        sequence: 2,
        eventType: "text.delta",
        payload: { text: "Safe", index: 0 },
      },
    ]);
  });

  it("merges model receipts when an attempt resumes", () => {
    const events = new FakeAppendPort();
    const first = makeWriter(events);
    first.recordReceipt({
      modelId: "claude-sonnet-5",
      provider: "anthropic",
      modelCallLatencyMs: 30,
      totalModelCallLatencyMs: 50,
      modelCallCount: 2,
      usage: { inputTokens: 20, outputTokens: 5 },
    });
    const resumed = makeWriter(events, 1, first.history("waiting"));

    resumed.recordReceipt({
      modelId: "claude-sonnet-5",
      provider: "anthropic",
      effortPreset: "thorough",
      modelCallLatencyMs: 40,
      usage: { inputTokens: 7, outputTokens: 3 },
    });

    expect(resumed.receipt).toEqual({
      modelId: "claude-sonnet-5",
      provider: "anthropic",
      effortPreset: "thorough",
      modelCallLatencyMs: 40,
      totalModelCallLatencyMs: 90,
      modelCallCount: 3,
      usage: { inputTokens: 27, outputTokens: 8 },
    });
  });

  it("keeps cumulative usage unknown when a resumed legacy receipt had no usage", () => {
    const events = new FakeAppendPort();
    const first = makeWriter(events);
    first.recordReceipt({
      modelId: "legacy-model",
      modelCallLatencyMs: 30,
    });
    const resumed = makeWriter(events, 1, first.history("waiting"));

    resumed.recordReceipt({
      modelId: "current-model",
      provider: "openai",
      modelCallLatencyMs: 40,
      usage: { inputTokens: 7, outputTokens: 3 },
    });

    expect(resumed.receipt).toMatchObject({
      modelId: "current-model",
      provider: "openai",
      modelCallLatencyMs: 40,
    });
    expect(resumed.receipt).not.toHaveProperty("usage");
  });

  it("projects the immutable durable delta after a crash, not the replayed model text", async () => {
    const events = new FakeAppendPort();
    await makeWriter(events).append(
      loopEvent({ sequence: 1, type: "text_delta", text: "Saved once.", textIndex: 0 })
    );

    const same = makeWriter(events);
    await same.append(
      loopEvent({ sequence: 1, type: "text_delta", text: "Saved once.", textIndex: 0 })
    );
    const diverged = makeWriter(events);
    await diverged.append(
      loopEvent({ sequence: 1, type: "text_delta", text: "Different replay.", textIndex: 0 })
    );

    expect(same.text).toBe("Saved once.");
    expect(diverged.text).toBe("Saved once.");
    expect(events.appended).toHaveLength(1);
  });

  it("does not project a durable event already included in the restored cursor", async () => {
    const events = new FakeAppendPort();
    const first = makeWriter(events);
    await first.append(
      loopEvent({ sequence: 1, type: "text_delta", text: "Already saved.", textIndex: 0 })
    );

    const resumed = makeWriter(events, 1, first.history("waiting"));
    await resumed.append(
      loopEvent({ sequence: 1, type: "text_delta", text: "Already saved.", textIndex: 0 })
    );

    expect(resumed.text).toBe("Already saved.");
  });

  it("projects concurrent appends in durable sequence order", async () => {
    let sequence = 0;
    const events: RunEventAppendPort = {
      append: async (input) => {
        sequence += 1;
        const current = sequence;
        await new Promise((resolve) => setTimeout(resolve, current === 1 ? 10 : 0));
        return { sequence: current, eventType: input.eventType, payload: input.payload };
      },
    };
    const writer = makeWriter(events);

    await Promise.all([
      writer.emit("text.delta", { text: "First.", index: 0 }, "first"),
      writer.emit("text.delta", { text: "Second.", index: 1 }, "second"),
    ]);

    expect(writer.text).toBe("First.Second.");
    expect(writer.cursor).toBe(2);
  });

  describe("projecting loop events", () => {
    it("releases model text as text.delta in order", async () => {
      const events = new FakeAppendPort();
      const writer = makeWriter(events);

      await writer.append(
        loopEvent({ sequence: 1, type: "text_delta", text: "Hel", textIndex: 1 })
      );
      await writer.append(loopEvent({ sequence: 2, type: "text_delta", text: "lo", textIndex: 2 }));

      expect(events.appended.map((event) => event.payload)).toEqual([
        { text: "Hel", index: 1 },
        { text: "lo", index: 2 },
      ]);
      expect(events.appended.map((event) => event.idempotencyKey)).toEqual([
        "turn-1:1:loop:1",
        "turn-1:1:loop:2",
      ]);
    });

    it("reports a call the loop refused, since no dispatcher saw it", async () => {
      const events = new FakeAppendPort();
      const writer = makeWriter(events);

      await writer.append(
        loopEvent({
          type: "tool_call_rejected",
          callId: "call-1",
          toolName: "wire_money",
          outcome: "tool_not_available",
          participantActivity: "visible",
        })
      );
      await writer.append(
        loopEvent({
          sequence: 2,
          type: "tool_call_rejected",
          callId: "call-1",
          toolName: "wire_money",
          outcome: "tool_not_available",
          participantActivity: "visible",
        })
      );

      expect(events.appended).toEqual([
        {
          eventType: "tool.result",
          audience: "participant",
          payload: {
            callId: "call-1",
            name: "wire_money",
            status: "error",
            errorCode: "tool_not_available",
            participantActivity: "visible",
          },
          idempotencyKey: "turn-1:1:loop:1",
        },
        expect.objectContaining({ idempotencyKey: "turn-1:1:loop:2" }),
      ]);
      expect(writer.toolCalls).toEqual([
        {
          callId: "call-1",
          name: "wire_money",
          outcome: "error",
          errorCode: "tool_not_available",
          participantActivity: "visible",
        },
      ]);
    });

    it("never leaks Tool arguments or output into the stream", async () => {
      const events = new FakeAppendPort();
      const writer = makeWriter(events);

      await writer.append(
        loopEvent({
          sequence: 1,
          type: "tool_call_dispatched",
          callId: "call-1",
          toolName: "send_email",
          outcome: "succeeded",
        })
      );

      // The dispatch port holds the arguments and output, so it decides what a channel may see.
      expect(events.appended).toHaveLength(0);
    });

    it("drops loop bookkeeping and terminal events, which the driver owns", async () => {
      const events = new FakeAppendPort();
      const writer = makeWriter(events);

      await writer.append(loopEvent({ sequence: 1, type: "iteration_started" }));
      await writer.append(loopEvent({ sequence: 2, type: "awaiting_approval", callId: "call-1" }));
      await writer.append(loopEvent({ sequence: 3, type: "completed" }));
      await writer.append(loopEvent({ sequence: 4, type: "failed" }));
      await writer.append(loopEvent({ sequence: 5, type: "cancelled" }));

      expect(events.appended).toHaveLength(0);
    });

    it("fails loudly when an attempt replays a sequence, rather than swallowing the event", async () => {
      const events = new FakeAppendPort();
      const writer = makeWriter(events);

      await writer.append(loopEvent({ sequence: 1, type: "text_delta", text: "a", textIndex: 1 }));

      await expect(
        writer.append(loopEvent({ sequence: 1, type: "text_delta", text: "b", textIndex: 1 }))
      ).rejects.toBeInstanceOf(DuplicateLoopEventError);
    });
  });
});

describe("a call the loop collapsed into an identical one", () => {
  /** Seeds the sibling that actually ran, exactly as the dispatch-port wrapper would. */
  async function seedSibling(
    writer: TurnEventWriter,
    over: { outcome?: "ok" | "error"; errorCode?: string } = {}
  ): Promise<void> {
    await writer.emit(
      "tool.call",
      {
        callId: "call-1",
        name: "github.issue.search",
        argsDigest: "sha256:args",
        argsPreview: { json: '{"q":"open"}' },
        batchId: "state-1:0:0",
      },
      "tool:call:call-1"
    );
    await writer.emit(
      "tool.result",
      {
        callId: "call-1",
        status: over.outcome ?? "ok",
        ...(over.errorCode === undefined ? {} : { errorCode: over.errorCode }),
      },
      "tool:result:call-1"
    );
  }

  it("still reaches Chat, described from the call that ran, but outside its batch", async () => {
    const events = new FakeAppendPort();
    const writer = makeWriter(events);
    await seedSibling(writer);

    await writer.append(
      loopEvent({
        sequence: 1,
        type: "tool_call_dispatched",
        callId: "call-2",
        toolName: "github.issue.search",
        outcome: "succeeded",
        answeredFromCallId: "call-1",
      })
    );

    const synthesized = events.appended.slice(2);
    expect(synthesized.map((event) => event.eventType)).toEqual(["tool.call", "tool.result"]);
    expect(synthesized[0]?.payload).toMatchObject({
      callId: "call-2",
      name: "github.issue.search",
      argsDigest: "sha256:args",
    });
    // No Tool ran for it, so counting it towards "N at the same time" would overstate the Run.
    expect(synthesized[0]?.payload).not.toHaveProperty("batchId");
    expect(synthesized[1]?.payload).toMatchObject({
      callId: "call-2",
      status: "ok",
      summary: "Asked twice, answered from the identical call",
    });
    expect(writer.toolCalls.map((call) => call.callId)).toEqual(["call-1", "call-2"]);
  });

  it("inherits the failure, so a duplicate of a failed call is not a clean success", async () => {
    const events = new FakeAppendPort();
    const writer = makeWriter(events);
    await seedSibling(writer, { outcome: "error", errorCode: "forbidden" });

    await writer.append(
      loopEvent({
        sequence: 1,
        type: "tool_call_dispatched",
        callId: "call-2",
        toolName: "github.issue.search",
        answeredFromCallId: "call-1",
      })
    );

    expect(events.appended.at(-1)?.payload).toMatchObject({
      callId: "call-2",
      status: "error",
      errorCode: "forbidden",
    });
  });

  // Understating is the safe direction: a row invented from a call still in flight would describe
  // an outcome nobody has yet.
  it("stays silent when the call it was collapsed into has not settled", async () => {
    const events = new FakeAppendPort();
    const writer = makeWriter(events);
    await writer.emit(
      "tool.call",
      { callId: "call-1", name: "github.issue.search", argsDigest: "sha256:args" },
      "tool:call:call-1"
    );

    await writer.append(
      loopEvent({
        sequence: 1,
        type: "tool_call_dispatched",
        callId: "call-2",
        toolName: "github.issue.search",
        answeredFromCallId: "call-1",
      })
    );

    expect(events.appended).toHaveLength(1);
  });
});
