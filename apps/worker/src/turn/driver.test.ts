import type { AgentLoopInput, AgentLoopOutcome } from "@tulipfarm/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { AgentStateRunner } from "../agent-state";
import {
  ConversationTurnCompleter,
  type TurnCompletionRecord,
  type TurnCompletionStore,
} from "../conversation-turn";
import {
  type ResolvedTurnContext,
  type TurnContextPort,
  TurnDriver,
  type TurnRequest,
} from "./driver";
import { type RunEventAppendPort, TurnEventWriter } from "./run-events";

const CONTEXT: ResolvedTurnContext = {
  agentId: "agent-1",
  modelProfileId: "primary",
  contextDigest: "sha256:context",
  guardrailDigest: "sha256:guardrail",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  limits: { maxIterations: 4, maxToolCalls: 4, maxRepairAttempts: 2 },
  compacted: false,
};

function request(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    businessId: "biz",
    runId: "run-1",
    stateKey: "state-1",
    stateStatus: "claimed",
    turnId: "turn-1",
    conversationId: "conv-1",
    attempt: 1,
    ...over,
  };
}

class FakeAppendPort implements RunEventAppendPort {
  readonly appended: { eventType: string; payload: Record<string, unknown> }[] = [];
  private sequence = 0;

  async append(input: {
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ sequence: number }> {
    this.sequence += 1;
    this.appended.push({ eventType: input.eventType, payload: input.payload });
    return { sequence: this.sequence };
  }
}

class FakeCompletionStore implements TurnCompletionStore {
  readonly messages: { content: string; attempt: number }[] = [];
  readonly completed: { status: string; cursor: number; messageId: string | null }[] = [];

  async findCompletion(): Promise<TurnCompletionRecord | undefined> {
    return undefined;
  }

  async appendAssistantMessage(input: {
    attempt: number;
    content: string;
  }): Promise<{ messageId: string }> {
    this.messages.push({ content: input.content, attempt: input.attempt });
    return { messageId: `msg-${this.messages.length}` };
  }

  async completeTurn(input: {
    status: string;
    cursor: number;
    messageId: string | null;
  }): Promise<void> {
    this.completed.push({
      status: input.status,
      cursor: input.cursor,
      messageId: input.messageId,
    });
  }
}

function harness(
  outcome: AgentLoopOutcome | (() => Promise<AgentLoopOutcome>),
  over: { context?: Partial<ResolvedTurnContext>; onLoop?: (input: AgentLoopInput) => void } = {}
) {
  const events = new FakeAppendPort();
  const store = new FakeCompletionStore();
  const transitions: { from: string; to: string }[] = [];

  const context: TurnContextPort = {
    resolve: vi.fn(async () => ({ ...CONTEXT, ...over.context })),
  };

  const states = new AgentStateRunner({
    loop: {
      run: async (input) => {
        over.onLoop?.(input);
        return typeof outcome === "function" ? await outcome() : outcome;
      },
    },
    transitions: {
      transition: async (input) => {
        transitions.push({ from: input.from, to: input.to });
      },
    },
    waits: { register: async () => ({ waitId: "wait-1" }) },
  });

  const driver = new TurnDriver({
    states,
    context,
    completer: new ConversationTurnCompleter({ store }),
    buildEvents: (turn) =>
      new TurnEventWriter({
        events,
        businessId: turn.businessId,
        runId: turn.runId,
        turnId: turn.turnId,
        attempt: turn.attempt,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      }),
  });

  return { driver, events, store, transitions, context };
}

const counters = { iterations: 1, toolCalls: 0, repairs: 0 };

describe("TurnDriver", () => {
  it("announces the turn and what the model was given before running it", async () => {
    const { driver, events } = harness({ status: "completed", output: "hi there", ...counters });
    await driver.run(request());

    expect(events.appended.slice(0, 2)).toEqual([
      {
        eventType: "turn.started",
        payload: { turnId: "turn-1", attempt: 1, agentId: "agent-1", conversationId: "conv-1" },
      },
      {
        eventType: "context.assembled",
        payload: {
          contextDigest: "sha256:context",
          guardrailDigest: "sha256:guardrail",
          messageCount: 1,
          compacted: false,
          modelProfileId: "primary",
        },
      },
    ]);
  });

  it("runs the loop over the context it published evidence for, resolved once", async () => {
    const seen: AgentLoopInput[] = [];
    const { driver, context } = harness(
      { status: "completed", output: "hi", ...counters },
      { onLoop: (input) => seen.push(input) }
    );
    await driver.run(request());

    expect(context.resolve).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId: "run-1",
      stateId: "state-1",
      modelProfileId: "primary",
      contextDigest: "sha256:context",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("persists the assistant Message before announcing that the turn finished", async () => {
    const { driver, events, store } = harness({
      status: "completed",
      output: "the answer",
      ...counters,
    });
    const outcome = await driver.run(request());

    expect(outcome).toBe("succeeded");
    expect(store.messages).toEqual([{ content: "the answer", attempt: 1 }]);
    // A reader that sees `turn.finished` can fetch the Message it names.
    expect(events.appended.at(-1)).toEqual({
      eventType: "turn.finished",
      payload: { status: "succeeded", messageId: "msg-1" },
    });
  });

  it("records the event cursor so a reader resumes strictly after this attempt", async () => {
    const { driver, store } = harness({ status: "completed", output: "hi", ...counters });
    await driver.run(request());

    // turn.started + context.assembled were written before completion.
    expect(store.completed).toEqual([{ status: "succeeded", cursor: 2, messageId: "msg-1" }]);
  });

  it("parks on the wait and writes no Message when a Tool needs approval", async () => {
    const { driver, events, store } = harness({
      status: "awaiting_approval",
      approvalId: "appr-1",
      callId: "call-1",
      ...counters,
    });
    const outcome = await driver.run(request());

    expect(outcome).toBe("waiting");
    expect(store.messages).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(events.appended.at(-1)).toEqual({
      eventType: "approval.requested",
      payload: { waitId: "wait-1", intentId: "appr-1" },
    });
  });

  it("reports a failed loop as a finished turn with no Message", async () => {
    const { driver, events, store } = harness({
      status: "failed",
      reason: "iteration_limit",
      ...counters,
    });
    const outcome = await driver.run(request());

    expect(outcome).toBe("failed");
    expect(store.messages).toEqual([]);
    expect(store.completed).toEqual([{ status: "failed", cursor: 2, messageId: null }]);
    expect(events.appended.at(-1)).toEqual({
      eventType: "turn.finished",
      payload: { status: "failed", messageId: null, reason: "iteration_limit" },
    });
  });

  it("names reconciliation as the reason rather than reporting a plain failure", async () => {
    // A loop that throws mid-flight may have landed an effect; the State runner says so.
    const { driver, events, store } = harness(async () => {
      throw new Error("worker crashed");
    });

    expect(await driver.run(request())).toBe("needs_reconciliation");
    expect(store.messages).toEqual([]);
    expect(events.appended.at(-1)).toEqual({
      eventType: "turn.finished",
      payload: { status: "failed", messageId: null, reason: "needs_reconciliation" },
    });
  });

  it("leaves a cancelled Run to the cancellation manager and records nothing", async () => {
    const { driver, events, store } = harness({ status: "cancelled", ...counters });
    const before = events.appended.length;
    const outcome = await driver.run(request());

    expect(outcome).toBe("cancelled");
    expect(store.completed).toEqual([]);
    // Only the two pre-loop events; no terminal event contradicting the manager's transition.
    expect(events.appended.length).toBe(before + 2);
  });

  it("fails the turn rather than posting a blank Message when the model returned nothing", async () => {
    const { driver, store } = harness({ status: "completed", output: "", ...counters });
    const outcome = await driver.run(request());

    expect(outcome).toBe("failed");
    expect(store.messages).toEqual([]);
    expect(store.completed).toEqual([{ status: "failed", cursor: 2, messageId: null }]);
  });

  it('fails rather than posting a Message that reads "null"', async () => {
    const { driver, store } = harness({ status: "completed", output: null, ...counters });
    const outcome = await driver.run(request());

    expect(outcome).toBe("failed");
    expect(store.messages).toEqual([]);
  });

  it("serializes a structured answer instead of dropping it", async () => {
    const { driver, store } = harness({
      status: "completed",
      output: { label: "bug" },
      ...counters,
    });
    await driver.run(request());

    expect(store.messages).toEqual([{ content: '{"label":"bug"}', attempt: 1 }]);
  });

  it("spends nothing on an attempt a newer one already superseded", async () => {
    const { driver, events, store, context } = harness({
      status: "completed",
      output: "old",
      ...counters,
    });
    const outcome = await driver.run(request({ attempt: 1, latestAttempt: 2 }));

    expect(outcome).toBe("succeeded");
    expect(store.messages).toEqual([]);
    expect(events.appended).toEqual([]);
    // The point of the early check: no Context resolved, so no model call and no Tool dispatch.
    expect(context.resolve).not.toHaveBeenCalled();
  });
});
