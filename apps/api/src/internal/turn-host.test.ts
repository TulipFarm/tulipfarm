import { describe, expect, it } from "vitest";
import {
  BUSINESS_ID,
  CONVERSATION_ID,
  CREATED_AT,
  FakeConversationStore,
  fakeRuns,
  RUN_ID,
  TURN_ID,
  turn,
} from "../test/turn-host-fixtures";
import {
  type HostedRunReader,
  type HostedToolResult,
  InternalTurnHost,
  type TurnAuthority,
  type TurnMemoryExtractor,
} from "./turn-host";

const NOW = new Date("2026-07-27T00:01:00.000Z");

/** Records what the host hands the extractor, and nothing more — the seam is deliberately one-way. */
class RecordingMemory implements TurnMemoryExtractor {
  readonly calls: {
    userId: string;
    runId?: string;
    outcome?: string;
    messages: readonly { content: string }[];
  }[] = [];
  private resolveIdle: (() => void) | undefined;

  async extractFromTurn(request: {
    userId: string;
    runId?: string;
    outcome?: string;
    messages: readonly { role: string; content: string }[];
  }): Promise<unknown> {
    this.calls.push(request);
    this.resolveIdle?.();
    return undefined;
  }

  /** Mining is detached, so a test has to let the microtask queue drain before asserting. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeHost(
  options: {
    runs?: HostedRunReader;
    store?: FakeConversationStore;
    memory?: TurnMemoryExtractor;
  } = {}
) {
  const store = options.store ?? new FakeConversationStore();
  const seen: { context: TurnAuthority[]; tools: TurnAuthority[] } = { context: [], tools: [] };
  let issued = 0;
  const host = new InternalTurnHost({
    runs: options.runs ?? fakeRuns(),
    store,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    context: {
      async resolve(authority) {
        seen.context.push(authority);
        return {
          agentId: "assistant",
          subjectId: authority.subject.id,
          modelProfileId: "model-1",
          contextDigest: "context-digest",
          guardrailDigest: "guardrail-digest",
          guardrailPolicy: { input: [] },
          messages: [],
          tools: [],
          limits: { maxIterations: 1, maxToolCalls: 1, maxRepairAttempts: 1 },
          compacted: false,
        };
      },
    },
    tools: {
      async dispatch(authority): Promise<HostedToolResult> {
        seen.tools.push(authority);
        return { status: "succeeded", output: null };
      },
    },
    newId: () => `message-${++issued}`,
    now: () => NOW,
  });
  return { host, store, seen };
}

describe("InternalTurnHost", () => {
  it("takes the subject from the Run, not from whoever asked", async () => {
    const store = new FakeConversationStore();
    store.turns.push(turn());
    const { host, seen } = makeHost({
      store,
      runs: fakeRuns({ subject: { kind: "integration", id: "slack" }, digest: "bundle-9" }),
    });

    await host.resolveContext(BUSINESS_ID, RUN_ID);
    await host.dispatchTool(BUSINESS_ID, RUN_ID, { callId: "c1", name: "noop", arguments: {} });

    for (const authority of [...seen.context, ...seen.tools]) {
      expect(authority.subject).toEqual({ kind: "integration", id: "slack" });
      expect(authority.bundleDigest).toBe("bundle-9");
      expect(authority.turn.id).toBe(TURN_ID);
    }
  });

  it("refuses a Run it cannot find, cannot operate on, or that answers no Turn", async () => {
    const missingRun = makeHost({ runs: fakeRuns(null) });
    await expect(missingRun.host.resolveContext(BUSINESS_ID, RUN_ID)).rejects.toMatchObject({
      code: "run_not_found",
    });

    // The dispatcher holds a Run at `running` for the whole turn, so any other status means no
    // executor is entitled to write for it — a redelivery, or a worker whose lease was reclaimed.
    const settledStore = new FakeConversationStore();
    settledStore.turns.push(turn({ status: "succeeded" }));
    const settled = makeHost({ store: settledStore, runs: fakeRuns({ status: "succeeded" }) });
    await expect(settled.host.resolveContext(BUSINESS_ID, RUN_ID)).rejects.toMatchObject({
      code: "run_not_running",
    });

    // A Run superseded by a `same_turn` retry no longer names the Turn.
    const superseded = makeHost();
    await expect(superseded.host.resolveContext(BUSINESS_ID, RUN_ID)).rejects.toMatchObject({
      code: "turn_not_found",
    });
  });

  it("writes the reply before any completion names it", async () => {
    const store = new FakeConversationStore();
    store.turns.push(turn({ attempt: 2 }));
    const { host } = makeHost({ store });

    const { messageId } = await host.appendAssistantMessage({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      attempt: 2,
      content: "the answer",
      metadata: {
        toolCalls: [
          {
            callId: "call-1",
            name: "record_create",
            argsDigest: "sha256:args",
            outcome: "ok",
          },
        ],
      },
    });

    // Durable, attributed to the attempt, and not yet part of the conversation any reader replays.
    expect(store.messages).toEqual([
      {
        id: messageId,
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "assistant",
        content: "the answer",
        metadata: {
          toolCalls: [
            {
              callId: "call-1",
              name: "record_create",
              argsDigest: "sha256:args",
              outcome: "ok",
            },
          ],
        },
        attempt: 2,
        createdAt: NOW,
      },
    ]);
    expect(store.completions).toEqual([]);
  });

  it("completes the Turn and moves the reader's resume point with the answer", async () => {
    const store = new FakeConversationStore();
    store.turns.push(turn());
    const { host } = makeHost({ store });

    await host.completeTurn({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      attempt: 1,
      status: "succeeded",
      cursor: 12,
      messageId: "message-1",
    });

    expect(store.completions).toEqual([
      {
        businessId: BUSINESS_ID,
        turnId: TURN_ID,
        attempt: 1,
        status: "succeeded",
        messageId: "message-1",
        cursor: 12,
        createdAt: NOW,
      },
    ]);
    expect(store.turns[0]).toMatchObject({ status: "succeeded", cursor: 12, updatedAt: NOW });
    await expect(host.findCompletion(BUSINESS_ID, RUN_ID, 1)).resolves.toMatchObject({
      cursor: 12,
    });
    await expect(host.findCompletion(BUSINESS_ID, RUN_ID, 2)).resolves.toBeUndefined();
  });

  it("lets a superseded attempt record its outcome without restating the Turn's", async () => {
    const store = new FakeConversationStore();
    store.turns.push(turn({ attempt: 2, status: "succeeded", cursor: 12, updatedAt: CREATED_AT }));
    const { host } = makeHost({ store });

    // Attempt 1 dying late must not tell every reader the conversation broke.
    await host.completeTurn({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      attempt: 1,
      status: "failed",
      cursor: 3,
      messageId: null,
    });

    expect(store.completions).toHaveLength(1);
    expect(store.turns[0]).toMatchObject({
      status: "succeeded",
      cursor: 12,
      updatedAt: CREATED_AT,
    });
  });

  describe("mining a finished turn for memory", () => {
    async function complete(
      options: { memory: RecordingMemory; runs?: HostedRunReader },
      status: "succeeded" | "failed" = "succeeded"
    ) {
      const store = new FakeConversationStore();
      store.turns.push(turn());
      store.messages.push({
        id: "message-0",
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        role: "user",
        content: "I work at Acme.",
        attempt: 1,
        createdAt: CREATED_AT,
      });
      const { host } = makeHost({
        store,
        memory: options.memory,
        ...(options.runs ? { runs: options.runs } : {}),
      });
      await host.completeTurn({
        businessId: BUSINESS_ID,
        runId: RUN_ID,
        attempt: 1,
        status,
        cursor: 1,
        messageId: "message-0",
      });
      await options.memory.settle();
    }

    it("hands the completed conversation to the extractor", async () => {
      const memory = new RecordingMemory();
      await complete({ memory });

      expect(memory.calls).toHaveLength(1);
      expect(memory.calls[0].userId).toBe("user-1");
      expect(memory.calls[0].runId).toBe(RUN_ID);
      expect(memory.calls[0].outcome).toBe("succeeded");
      expect(memory.calls[0].messages.map((m) => m.content)).toEqual(["I work at Acme."]);
    });

    it("mines nothing from a failed turn", async () => {
      const memory = new RecordingMemory();
      await complete({ memory }, "failed");

      expect(memory.calls).toEqual([]);
    });

    it("mines nothing when the Run acts for something other than a user", async () => {
      const memory = new RecordingMemory();
      await complete({ memory, runs: fakeRuns({ subject: { kind: "agent", id: "agent-1" } }) });

      expect(memory.calls).toEqual([]);
    });

    it("completes the turn even when the extractor throws", async () => {
      const memory = new RecordingMemory();
      memory.extractFromTurn = async () => {
        throw new Error("extraction exploded");
      };
      const store = new FakeConversationStore();
      store.turns.push(turn());
      const { host } = makeHost({ store, memory });

      await expect(
        host.completeTurn({
          businessId: BUSINESS_ID,
          runId: RUN_ID,
          attempt: 1,
          status: "succeeded",
          cursor: 1,
          messageId: null,
        })
      ).resolves.toBeUndefined();
      await memory.settle();
      expect(store.turns[0].status).toBe("succeeded");
    });
  });
});
