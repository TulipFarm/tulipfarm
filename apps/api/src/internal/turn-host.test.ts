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
} from "./turn-host";

const NOW = new Date("2026-07-27T00:01:00.000Z");

function makeHost(options: { runs?: HostedRunReader; store?: FakeConversationStore } = {}) {
  const store = options.store ?? new FakeConversationStore();
  const seen: { context: TurnAuthority[]; tools: TurnAuthority[] } = { context: [], tools: [] };
  let issued = 0;
  const host = new InternalTurnHost({
    runs: options.runs ?? fakeRuns(),
    store,
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
});
