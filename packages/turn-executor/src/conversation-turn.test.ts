import { describe, expect, it } from "vitest";
import {
  ConversationTurnCompleter,
  type TurnCompletionRecord,
  type TurnCompletionRef,
  type TurnCompletionStore,
} from "./conversation-turn";

class FakeStore implements TurnCompletionStore {
  records: TurnCompletionRecord[] = [];
  appended: { turnId: string; attempt: number; content: string }[] = [];
  completed: { turnId: string; attempt: number; status: string; cursor: number }[] = [];
  surfaceMessages: {
    conversationId: string;
    surfaces: readonly { artifactId: string; revision: number }[];
  }[] = [];
  /** Every write states the Run it acts under; a store proving its authority needs it. */
  runIds: string[] = [];

  async findCompletion(ref: TurnCompletionRef): Promise<TurnCompletionRecord | undefined> {
    this.runIds.push(ref.runId);
    return this.records.find(
      (record) => record.turnId === ref.turnId && record.attempt === ref.attempt
    );
  }

  async appendAssistantMessage(
    input: TurnCompletionRef & { content: string }
  ): Promise<{ messageId: string }> {
    this.runIds.push(input.runId);
    this.appended.push({ turnId: input.turnId, attempt: input.attempt, content: input.content });
    return { messageId: `msg-${this.appended.length}` };
  }

  async completeTurn(
    input: TurnCompletionRef & {
      status: "succeeded" | "failed";
      cursor: number;
      messageId: string | null;
      conversationId?: string;
      surfaces?: readonly { artifactId: string; revision: number }[];
    }
  ): Promise<void> {
    this.runIds.push(input.runId);
    if (input.surfaces?.length) {
      this.surfaceMessages.push({
        conversationId: input.conversationId ?? "",
        surfaces: input.surfaces,
      });
    }
    this.completed.push({
      turnId: input.turnId,
      attempt: input.attempt,
      status: input.status,
      cursor: input.cursor,
    });
    this.records.push({
      turnId: input.turnId,
      attempt: input.attempt,
      status: input.status,
      messageId: input.messageId,
    });
  }
}

const request = {
  businessId: "biz-1",
  runId: "run-1",
  conversationId: "conv-1",
  turnId: "turn-1",
  attempt: 1,
  cursor: 12,
};

describe("ConversationTurnCompleter", () => {
  it("appends the assistant Message and completes the Turn at the final cursor", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });

    const result = await completer.complete({
      ...request,
      outcome: { status: "succeeded", text: "here is the summary" },
    });

    expect(store.appended).toEqual([
      { turnId: "turn-1", attempt: 1, content: "here is the summary" },
    ]);
    expect(store.completed).toEqual([
      { turnId: "turn-1", attempt: 1, status: "succeeded", cursor: 12 },
    ]);
    expect(result).toMatchObject({ status: "succeeded", messageId: "msg-1" });
    expect(new Set(store.runIds)).toEqual(new Set(["run-1"]));
  });

  it("is idempotent when the same attempt is redelivered after a crash", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });
    const input = { ...request, outcome: { status: "succeeded" as const, text: "done" } };

    const first = await completer.complete(input);
    const second = await completer.complete(input);

    expect(second).toEqual(first);
    expect(store.appended).toHaveLength(1);
    expect(store.completed).toHaveLength(1);
  });

  it("fails the Turn without inventing an assistant Message", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });

    const result = await completer.complete({
      ...request,
      outcome: { status: "failed", reason: "iteration_limit" },
    });

    expect(store.appended).toEqual([]);
    expect(store.completed).toEqual([
      { turnId: "turn-1", attempt: 1, status: "failed", cursor: 12 },
    ]);
    expect(result).toMatchObject({ status: "failed", reason: "iteration_limit" });
  });

  // A Turn that stops to ask has already shown the reader prose, Tool steps and a question. Ending
  // it with no Message left all three on the wire only, so a reload emptied the reply and stranded
  // the question it is waiting on.
  it("persists what an input-required Turn already showed the reader", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });

    const result = await completer.complete({
      ...request,
      outcome: { status: "input_required", text: "I need a few details first." },
      surfaces: [{ artifactId: "artifact-1", revision: 1 }],
    });

    expect(store.appended).toEqual([
      { turnId: "turn-1", attempt: 1, content: "I need a few details first." },
    ]);
    expect(store.surfaceMessages).toEqual([
      { conversationId: "conv-1", surfaces: [{ artifactId: "artifact-1", revision: 1 }] },
    ]);
    expect(store.completed).toEqual([
      { turnId: "turn-1", attempt: 1, status: "succeeded", cursor: 12 },
    ]);
    expect(result).toEqual({ status: "succeeded", messageId: "msg-1" });
  });

  // The model can call `request_input` with no preamble; the Message still has to exist, because
  // it is what carries the Tool steps the reader watched run.
  it("writes a Message for a wordless Turn that still ran Tools", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });

    const result = await completer.complete({
      ...request,
      outcome: { status: "input_required", text: "" },
      metadata: { toolCalls: [{ callId: "call-1", name: "list_resource_types" }] },
    });

    expect(store.appended).toEqual([{ turnId: "turn-1", attempt: 1, content: "" }]);
    expect(result).toEqual({ status: "succeeded", messageId: "msg-1" });
  });

  it("writes no Message when a Turn asked for input having said and done nothing", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });

    const result = await completer.complete({
      ...request,
      outcome: { status: "input_required", text: "" },
      surfaces: [{ artifactId: "artifact-1", revision: 1 }],
    });

    // The Surface is still linked: it is the question, and it is the whole point of the Turn.
    expect(store.appended).toEqual([]);
    expect(store.surfaceMessages).toHaveLength(1);
    expect(result).toEqual({ status: "succeeded", messageId: null });
  });

  it("leaves a waiting Turn open so the Approval can resume it", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });

    const result = await completer.complete({
      ...request,
      outcome: { status: "waiting", waitId: "wait-1" },
    });

    expect(store.appended).toEqual([]);
    expect(store.completed).toEqual([]);
    expect(result).toMatchObject({ status: "waiting", waitId: "wait-1" });
  });

  it("treats a superseded attempt as stale and does not overwrite the newer one", async () => {
    const store = new FakeStore();
    const completer = new ConversationTurnCompleter({ store });

    await completer.complete({
      ...request,
      attempt: 2,
      outcome: { status: "succeeded", text: "attempt two" },
    });
    const stale = await completer.complete({
      ...request,
      attempt: 1,
      outcome: { status: "succeeded", text: "attempt one" },
      latestAttempt: 2,
    });

    expect(stale).toMatchObject({ status: "stale" });
    expect(store.appended).toEqual([{ turnId: "turn-1", attempt: 2, content: "attempt two" }]);
  });
});
